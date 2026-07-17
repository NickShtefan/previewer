import type { ReviewKey, ReviewRun, Job, ContextPack, ResolvedContext, ChangedFile } from "../config";

/** Durable state: dedupe facts, run/audit records, webhook delivery idempotency. */
export interface Store {
  init(): Promise<void>;
  /**
   * Atomically claim (repo, pr, head_sha). "duplicate" means a successful review already
   * exists (or one is actively running). A failed ('error') run or a stale 'running' claim
   * is reclaimable; `force` reclaims regardless (re-review a completed SHA).
   */
  claimReview(key: ReviewKey, opts?: { force?: boolean; staleMs?: number }): Promise<"claimed" | "duplicate">;
  /**
   * Release an un-finalized claim: delete the 'running' placeholder claimReview inserted, so a
   * retry can re-claim and actually run. MUST be called when a claimed review fails BEFORE it
   * records a terminal run (e.g. the pipeline throws in workspace prep during a GitHub outage) —
   * otherwise the stuck 'running' row makes the retry a no-op "duplicate" and the review is lost.
   * No-op if the row was already finalized (ok/skipped/error) or is absent.
   */
  releaseClaim(key: ReviewKey): Promise<void>;
  recordRun(run: ReviewRun): Promise<void>;
  lastReviewedSha(repo: string, prNumber: number): Promise<string | null>;
  /** Has (repo, pr, head_sha) been successfully reviewed (status ok/skipped)? */
  isReviewed(repo: string, prNumber: number, headSha: string): Promise<boolean>;
  /**
   * Coverage check for the reconciler. True if this head has a terminal review
   * (ok/skipped), a live in-flight claim (status 'running' started within `staleMs`),
   * or a recent limit-classified error still inside `limitCooldownMs`. Prevents the
   * reconciler from double-spending on a head a forced review is already handling,
   * and from re-running codex into an active usage/rate limit. A stale 'running' (dead
   * worker) and non-limit errors return false so they still get retried.
   */
  isReviewedOrInFlight(
    repo: string,
    prNumber: number,
    headSha: string,
    opts?: { staleMs?: number; limitCooldownMs?: number },
  ): Promise<boolean>;
  seenDelivery(deliveryId: string): Promise<boolean>;
  markDelivery(deliveryId: string): Promise<void>;
}

export interface LeasedJob extends Job {
  leaseId: string;
}

/** Durable job queue with at-least-once delivery and visibility-timeout leases. */
export interface Queue {
  init(): Promise<void>;
  /**
   * UNIQUE per (repo, pr, head_sha): a second enqueue of the same key is a no-op ("duplicate").
   * `force` instead re-queues the existing head row (resets it to queued) and returns "requeued"
   * — used by the on-demand /rereview command to re-review an already-processed head.
   */
  enqueue(job: Job, opts?: { force?: boolean }): Promise<"enqueued" | "duplicate" | "requeued">;
  lease(visibilityTimeoutMs: number): Promise<LeasedJob | null>;
  ack(leaseId: string): Promise<void>;
  /**
   * Requeue with delay; dead-letters once `attempts` reaches the cap. The cap defaults
   * to the queue's `maxAttempts`, but a caller may pass a smaller `maxAttempts` (e.g. the
   * small bounded budget for UNKNOWN/unclassified failures) so those give up sooner.
   */
  nack(leaseId: string, retryInMs: number, opts?: { maxAttempts?: number }): Promise<void>;
  /**
   * Requeue after a TRANSIENT failure (outage / throttle / network) with exponential
   * back-off, WITHOUT consuming the dead-letter `attempts` budget. Use for failures
   * that must be retried through an arbitrarily long outage rather than lost; the
   * back-off delay is derived from a separate transient-retry counter and never
   * dead-letters. Permanent failures keep using `nack`.
   */
  nackTransient(leaseId: string): Promise<void>;
  /**
   * Earliest future `visible_at` among not-yet-leasable jobs (queued/running with a delay),
   * or null if none. Lets a long-lived single-process host (ingress) schedule a wake-up so a
   * backed-off retry actually fires on time instead of sleeping until the next webhook.
   */
  nextVisibleAt(): Promise<Date | null>;
}

export interface PrRef {
  repo: string;
  prNumber: number;
}

export interface PullRequestMeta {
  number: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  author: string;
  isDraft: boolean;
  state: "open" | "closed";
}

export interface DiffResult {
  mode: "incremental" | "full";
  fromSha: string;
  toSha: string;
  patch: string;
  changedFiles: ChangedFile[];
}

export interface GitHubClient {
  getPullRequest(ref: PrRef): Promise<PullRequestMeta>;
  listOpenPullRequests(repo: string): Promise<PullRequestMeta[]>;
  checkout(repo: string, sha: string): Promise<{ dir: string }>;
  diff(
    repo: string,
    fromSha: string,
    toSha: string,
    mode: "incremental" | "full",
  ): Promise<DiffResult>;
}

/** Publishes exactly one top-level comment per head SHA (idempotent via marker). */
export interface Publisher {
  upsertReviewComment(ref: PrRef, headSha: string, body: string): Promise<{ commentId: number }>;
}

export interface ContextProvider {
  getPack(repo: string): Promise<ContextPack | null>;
  /** Narrow the pack to only what the touched files need (cost control). */
  resolve(repo: string, changed: ChangedFile[]): Promise<ResolvedContext>;
}
