import {
  extractPullRequestEvent,
  extractIssueCommentEvent,
  matchesReviewCommand,
  commentAuthorCanCommand,
} from "../../github";
import type { WebhookVerifier } from "../../github";
import { makeJob } from "../../store";
import type { Store, Queue, GitHubClient } from "../../core";
import type { RepoConfig, ReviewKey } from "../../config";

export interface IngressDeps {
  verifier: WebhookVerifier;
  store: Pick<Store, "seenDelivery" | "markDelivery">;
  queue: Pick<Queue, "enqueue">;
  /** Resolves a PR's current head/base SHA for comment-triggered re-reviews. */
  github: Pick<GitHubClient, "getPullRequest">;
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
 * Verify HMAC -> dedup delivery -> route by event. `pull_request` events enqueue a review of
 * the pushed head; `issue_comment` events enqueue a FORCED FULL re-review when an authorized
 * author posts a review command (e.g. `/rereview`). Pure of HTTP, so it is fully unit-testable;
 * `enqueued` signals the caller to process.
 */
export async function handleWebhook(deps: IngressDeps, req: WebhookRequest): Promise<WebhookOutcome> {
  if (!deps.verifier.verify(req.rawBody, req.signature)) {
    return { status: 401, kind: "bad-signature", message: "invalid signature" };
  }
  if (req.event === "ping") return { status: 200, kind: "ping", message: "pong" };
  if (req.event !== "pull_request" && req.event !== "issue_comment") {
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

  return req.event === "issue_comment"
    ? handleIssueComment(deps, req, payload)
    : handlePullRequest(deps, req, payload);
}

/** Mark the delivery processed (idempotency) and return an `ignored` outcome. */
async function ignore(deps: IngressDeps, req: WebhookRequest, why: string): Promise<WebhookOutcome> {
  if (req.deliveryId) await deps.store.markDelivery(req.deliveryId);
  return { status: 202, kind: "ignored", message: `ignored (${why})` };
}

/** `pull_request` event: enqueue a review of the pushed head (config/action/draft gated). */
async function handlePullRequest(deps: IngressDeps, req: WebhookRequest, payload: unknown): Promise<WebhookOutcome> {
  const ev = extractPullRequestEvent(payload);
  if (!ev) return { status: 202, kind: "ignored", message: "not a pull_request payload" };

  const cfg = deps.repoConfigs.find((c) => c.repo.id === ev.repo && c.repo.enabled);
  const actionOk = cfg ? (cfg.events.triggers as string[]).includes(ev.action) : false;
  const draftOk = cfg ? !(ev.isDraft && cfg.events.ignoreDraft) : false;

  if (!cfg || !actionOk || !draftOk) {
    const why = !cfg ? `repo not configured: ${ev.repo}` : !actionOk ? `action ${ev.action}` : "draft";
    return ignore(deps, req, why);
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

/**
 * `issue_comment` event: a PR comment command (`/rereview`) from a write-access author enqueues a
 * FORCED FULL re-review of the PR's current head. "Full" so the whole PR is re-examined (not an
 * empty incremental delta — this also covers a branch reverted to an already-reviewed SHA). The
 * head SHA is not in the comment payload, so it is resolved via the GitHub client.
 */
async function handleIssueComment(deps: IngressDeps, req: WebhookRequest, payload: unknown): Promise<WebhookOutcome> {
  const ev = extractIssueCommentEvent(payload);
  if (!ev) return { status: 202, kind: "ignored", message: "not an issue_comment payload" };

  // Only act on a freshly-created comment; an edit could retroactively inject a command.
  if (ev.action !== "created") return ignore(deps, req, `comment ${ev.action}`);
  if (!ev.isPullRequest) return ignore(deps, req, "comment not on a PR");
  if (!matchesReviewCommand(ev.commentBody)) return ignore(deps, req, "no command");

  const cfg = deps.repoConfigs.find((c) => c.repo.id === ev.repo && c.repo.enabled);
  if (!cfg) return ignore(deps, req, `repo not configured: ${ev.repo}`);

  // Security: only a write-level author (OWNER/MEMBER/COLLABORATOR) may trigger a review.
  // Anyone else is ignored silently (logged) so an arbitrary commenter cannot spend tokens.
  if (!commentAuthorCanCommand(ev.authorAssociation)) {
    deps.logger.warn(
      `ignoring re-review command from ${ev.commentAuthor || "(unknown)"} ` +
        `(association=${ev.authorAssociation || "(none)"}) on ${ev.repo}#${ev.issueNumber}`,
    );
    return ignore(deps, req, "author not authorized");
  }

  // The comment payload carries no SHA — resolve the PR's current head/base.
  let pr;
  try {
    pr = await deps.github.getPullRequest({ repo: ev.repo, prNumber: ev.issueNumber });
  } catch (e) {
    // Do NOT mark the delivery: a manual redelivery can retry a transient GitHub failure.
    const message = e instanceof Error ? e.message : String(e);
    deps.logger.warn(`re-review: getPullRequest(${ev.repo}#${ev.issueNumber}) failed: ${message}`);
    return { status: 500, kind: "error", message: `failed to resolve PR head: ${message}` };
  }
  if (pr.state === "closed") return ignore(deps, req, "PR is closed");
  if (pr.isDraft && cfg.events.ignoreDraft) return ignore(deps, req, "PR is draft");

  // Force-requeue (bypass the head-SHA queue dedupe) so an already-reviewed/reverted head is
  // re-reviewed; `full: true` on the job forces base..head in the pipeline (bypasses incremental).
  const r = await deps.queue.enqueue(
    makeJob({
      repo: ev.repo,
      prNumber: ev.issueNumber,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      source: "manual",
      full: true,
    }),
    { force: true },
  );
  if (req.deliveryId) await deps.store.markDelivery(req.deliveryId);

  const key: ReviewKey = { repo: ev.repo, prNumber: ev.issueNumber, headSha: pr.headSha };
  const verb = r === "requeued" ? "re-queued" : "enqueued";
  return {
    status: 202,
    kind: "enqueued",
    message: `re-review ${verb} ${ev.repo}#${ev.issueNumber}@${pr.headSha.slice(0, 8)}`,
    enqueued: key,
  };
}
