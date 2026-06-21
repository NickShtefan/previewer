import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookVerifier {
  verify(rawBody: string, signature256: string): boolean;
}

/** Constant-time HMAC-SHA256 verification of `X-Hub-Signature-256`. */
export class GithubWebhookVerifier implements WebhookVerifier {
  constructor(private readonly secret: string) {}

  verify(rawBody: string, signature256: string): boolean {
    if (!this.secret || !signature256) return false;
    const expected = "sha256=" + createHmac("sha256", this.secret).update(rawBody, "utf8").digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature256);
    if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
    return timingSafeEqual(a, b);
  }
}

export interface PullRequestEvent {
  action: string;
  repo: string; // owner/name
  prNumber: number;
  headSha: string;
  baseSha: string;
  isDraft: boolean;
  title: string;
  body: string;
  author: string;
  state: "open" | "closed";
}

const RELEVANT_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

/** Pure extraction of the fields we care about from a `pull_request` webhook payload. */
export function extractPullRequestEvent(payload: unknown): PullRequestEvent | null {
  const p = payload as Record<string, any>;
  if (!p || typeof p !== "object" || !p.pull_request || !p.repository) return null;
  const pr = p.pull_request;
  return {
    action: String(p.action ?? ""),
    repo: String(p.repository.full_name ?? ""),
    prNumber: Number(p.number ?? pr.number ?? 0),
    headSha: String(pr.head?.sha ?? ""),
    baseSha: String(pr.base?.sha ?? ""),
    isDraft: Boolean(pr.draft),
    title: String(pr.title ?? ""),
    body: String(pr.body ?? ""),
    author: String(pr.user?.login ?? ""),
    state: pr.state === "closed" ? "closed" : "open",
  };
}

/** Should this event trigger a review run? (relevant action + not a draft) */
export function isRelevant(ev: PullRequestEvent, ignoreDraft = true): boolean {
  if (!RELEVANT_ACTIONS.has(ev.action)) return false;
  if (ignoreDraft && ev.isDraft) return false;
  return true;
}
