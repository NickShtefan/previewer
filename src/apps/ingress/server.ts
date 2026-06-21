import { extractPullRequestEvent } from "../../github";
import type { WebhookVerifier } from "../../github";
import { makeJob } from "../../store";
import type { Store, Queue } from "../../core";
import type { RepoConfig, ReviewKey } from "../../config";

export interface IngressDeps {
  verifier: WebhookVerifier;
  store: Pick<Store, "seenDelivery" | "markDelivery">;
  queue: Pick<Queue, "enqueue">;
  repoConfigs: RepoConfig[];
  logger: { info(m: string): void; warn(m: string): void };
}

export interface WebhookRequest {
  event: string;
  deliveryId: string;
  signature: string;
  rawBody: string;
}

export type WebhookKind =
  | "enqueued"
  | "queued-duplicate"
  | "ignored"
  | "duplicate-delivery"
  | "bad-signature"
  | "ping"
  | "error";

export interface WebhookOutcome {
  status: number;
  kind: WebhookKind;
  message: string;
  enqueued?: ReviewKey;
}

/**
 * Verify HMAC -> dedup delivery -> filter (event/action/draft/repo) -> enqueue.
 * Pure of HTTP, so it is fully unit-testable; `enqueued` signals the caller to process.
 */
export async function handleWebhook(deps: IngressDeps, req: WebhookRequest): Promise<WebhookOutcome> {
  if (!deps.verifier.verify(req.rawBody, req.signature)) {
    return { status: 401, kind: "bad-signature", message: "invalid signature" };
  }
  if (req.event === "ping") return { status: 200, kind: "ping", message: "pong" };
  if (req.event !== "pull_request") {
    return { status: 202, kind: "ignored", message: `ignored event: ${req.event || "(none)"}` };
  }
  if (req.deliveryId && (await deps.store.seenDelivery(req.deliveryId))) {
    return { status: 200, kind: "duplicate-delivery", message: "duplicate delivery" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, kind: "error", message: "invalid JSON body" };
  }
  const ev = extractPullRequestEvent(payload);
  if (!ev) return { status: 202, kind: "ignored", message: "not a pull_request payload" };

  const cfg = deps.repoConfigs.find((c) => c.repo.id === ev.repo && c.repo.enabled);
  const actionOk = cfg ? (cfg.events.triggers as string[]).includes(ev.action) : false;
  const draftOk = cfg ? !(ev.isDraft && cfg.events.ignoreDraft) : false;

  if (!cfg || !actionOk || !draftOk) {
    if (req.deliveryId) await deps.store.markDelivery(req.deliveryId);
    const why = !cfg ? `repo not configured: ${ev.repo}` : !actionOk ? `action ${ev.action}` : "draft";
    return { status: 202, kind: "ignored", message: `ignored (${why})` };
  }

  const r = await deps.queue.enqueue(
    makeJob({ repo: ev.repo, prNumber: ev.prNumber, headSha: ev.headSha, baseSha: ev.baseSha, source: "webhook" }),
  );
  if (req.deliveryId) await deps.store.markDelivery(req.deliveryId);

  const key: ReviewKey = { repo: ev.repo, prNumber: ev.prNumber, headSha: ev.headSha };
  return r === "enqueued"
    ? { status: 202, kind: "enqueued", message: `enqueued ${ev.repo}#${ev.prNumber}@${ev.headSha.slice(0, 8)}`, enqueued: key }
    : { status: 202, kind: "queued-duplicate", message: "already queued", enqueued: key };
}
