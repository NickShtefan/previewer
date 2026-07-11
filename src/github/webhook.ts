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

export interface IssueCommentEvent {
  action: string; // created | edited | deleted
  repo: string; // owner/name
  issueNumber: number;
  /** True only when the commented-on issue is a pull request (issue.pull_request present). */
  isPullRequest: boolean;
  commentBody: string;
  commentAuthor: string;
  /** GitHub's relationship of the author to the repo: OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR | NONE | ... */
  authorAssociation: string;
}

/** Pure extraction of the fields we care about from an `issue_comment` webhook payload. */
export function extractIssueCommentEvent(payload: unknown): IssueCommentEvent | null {
  const p = payload as Record<string, any>;
  if (!p || typeof p !== "object" || !p.issue || !p.comment || !p.repository) return null;
  return {
    action: String(p.action ?? ""),
    repo: String(p.repository.full_name ?? ""),
    issueNumber: Number(p.issue.number ?? 0),
    isPullRequest: Boolean(p.issue.pull_request),
    commentBody: String(p.comment.body ?? ""),
    commentAuthor: String(p.comment.user?.login ?? ""),
    authorAssociation: String(p.comment.author_association ?? p.issue.author_association ?? ""),
  };
}

/**
 * Comment-command triggers that request a fresh full review of a PR's current head.
 * A line whose trimmed text equals a trigger (or starts with `trigger + space`) matches,
 * so `/rereview` and `@previewer rereview please` both fire, case-insensitively.
 */
export const REVIEW_COMMAND_TRIGGERS = ["/rereview", "@previewer rereview"] as const;

/** Does a comment body contain a re-review command on one of its lines? */
export function matchesReviewCommand(body: string): boolean {
  if (!body) return false;
  return body.split(/\r?\n/).some((line) => {
    const t = line.trim().toLowerCase();
    return REVIEW_COMMAND_TRIGGERS.some((trig) => t === trig || t.startsWith(`${trig} `));
  });
}

/**
 * Author associations that imply write access to the repo. `author_association` on the
 * payload is the best signal available without a second API call: OWNER (repo owner),
 * MEMBER (org member), COLLABORATOR (added collaborator). CONTRIBUTOR / NONE do NOT imply
 * write, so a command from them is ignored — an arbitrary commenter cannot trigger reviews.
 */
const WRITE_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Is the comment author allowed to issue review commands (has a write-level association)? */
export function commentAuthorCanCommand(authorAssociation: string): boolean {
  return WRITE_ASSOCIATIONS.has(String(authorAssociation).toUpperCase());
}
