/* Read-only status queries for the LAN dashboard.
   Everything here reads the existing SQLite store (jobs + review_runs); nothing
   is written. Fields the store does not persist (per-severity finding counts, the
   review verdict) are surfaced as `null` and disclosed in `status.notes` rather
   than invented — see src/runners/shared/output.ts, where severitySummary is
   computed at review time and embedded in the posted GitHub comment, not the DB. */
import type { Db } from "../../store";

/** A review the store currently marks in-flight (review_runs.status = 'running'). */
export interface ReviewerNow {
  repo: string;
  prNumber: number;
  headSha: string;
  /** runner/model/effort are written only when a run FINALIZES, so they are
      typically null while the review is still in flight. */
  runner: string | null;
  model: string | null;
  reasoningEffort: string | null;
  startedAt: string;
  ageSeconds: number;
  /** true when started_at is older than the 15-min claim staleness window —
      the review likely crashed rather than being genuinely live. */
  stale: boolean;
  /** Queue-side enrichment from the matching leased job, if one exists. */
  source: string | null;
  attempts: number | null;
}

/** One tracked PR, rolled up across every head SHA the store has a run for. */
export interface PrRow {
  repo: string;
  prNumber: number;
  /** Most recently reviewed head SHA. */
  headSha: string;
  /** Finalized review runs for this PR (one row per head SHA). */
  rounds: number;
  /** Of those, how many produced a GitHub comment (comment_id present). */
  posted: number;
  /** Closest thing to a "verdict" the store keeps: ok | skipped | error. */
  lastStatus: string;
  lastRunner: string | null;
  lastModel: string | null;
  lastReasoningEffort: string | null;
  lastCommentId: number | null;
  lastError: string | null;
  lastAt: string;
  /** Not persisted by the store (lives only in the posted comment markdown). */
  findingsBySeverity: null;
}

export interface QueueCounts {
  enqueued: number;
  inFlight: number;
  done: number;
  skipped: number;
  error: number;
  deadLetter: number;
}

export interface RecentError {
  repo: string;
  prNumber: number;
  headSha: string;
  runner: string | null;
  model: string | null;
  error: string;
  /** Classified from the message text; the store has no dedicated status. */
  kind: "rate_limit" | "error";
  at: string;
}

export interface DashboardStatus {
  reviewers: ReviewerNow[];
  prs: PrRow[];
  queue: QueueCounts & { recentErrors: RecentError[] };
  updatedAt: string;
  notes: string[];
}

/** claimReview marks a review-runs row stale after 15 min (see SqliteStore). */
const STALE_MS = 15 * 60 * 1000;

const NOTES: string[] = [
  "Findings-by-severity and the review verdict are computed at review time and " +
    "embedded in the posted GitHub comment (severitySummary); they are NOT persisted " +
    "in the SQLite store, so this dashboard cannot show them.",
  "For an in-flight review the store's placeholder row carries no runner/model/effort " +
    "(those are written only when the run finalizes), so 'Reviewing now' may show them null.",
  "'rounds' = finalized review runs per PR (one per head SHA); 'posted' = those that " +
    "produced a GitHub comment. 'last status' (ok/skipped/error) is the nearest stored verdict.",
];

const RATE_LIMIT_RE =
  /rate.?limit|usage.?limit|quota|too many requests|\b429\b|overloaded|subscription_rate_limits/i;

function hasTable(db: Db, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
  return row !== undefined;
}

/** Assemble the full dashboard status from the store. Pure read; never mutates. */
export function buildStatus(db: Db, now: () => Date = () => new Date()): DashboardStatus {
  const at = now();
  const notes = [...NOTES];

  const reviewers = hasReviewRuns(db) ? reviewersNow(db, at, notes) : [];
  const prs = hasReviewRuns(db) ? trackedPrs(db, notes) : [];
  const queue = hasTable(db, "jobs") ? queueCounts(db, notes) : emptyQueue();
  const recentErrors = hasReviewRuns(db) ? recentErrors_(db, notes) : [];

  return {
    reviewers,
    prs,
    queue: { ...queue, recentErrors },
    updatedAt: at.toISOString(),
    notes,
  };
}

function hasReviewRuns(db: Db): boolean {
  return hasTable(db, "review_runs");
}

interface ReviewerRow {
  repo: string;
  prNumber: number;
  headSha: string;
  runner: string | null;
  model: string | null;
  reasoningEffort: string | null;
  startedAt: string;
  source: string | null;
  attempts: number | null;
}

function reviewersNow(db: Db, at: Date, notes: string[]): ReviewerNow[] {
  try {
    const rows = db
      .prepare(
        `SELECT rr.repo AS repo, rr.pr_number AS prNumber, rr.head_sha AS headSha,
                rr.runner AS runner, rr.model AS model, rr.reasoning_effort AS reasoningEffort,
                rr.started_at AS startedAt, j.source AS source, j.attempts AS attempts
           FROM review_runs rr
           LEFT JOIN jobs j
             ON j.repo = rr.repo AND j.pr_number = rr.pr_number AND j.head_sha = rr.head_sha
          WHERE rr.status = 'running'
          ORDER BY rr.started_at DESC`,
      )
      .all() as ReviewerRow[];
    return rows.map((r) => {
      const started = Date.parse(r.startedAt);
      const ageMs = Number.isFinite(started) ? at.getTime() - started : 0;
      return {
        repo: r.repo,
        prNumber: r.prNumber,
        headSha: r.headSha,
        runner: r.runner,
        model: r.model,
        reasoningEffort: r.reasoningEffort,
        startedAt: r.startedAt,
        ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
        stale: ageMs > STALE_MS,
        source: r.source,
        attempts: r.attempts,
      };
    });
  } catch (e) {
    notes.push(`reviewers unavailable: ${msg(e)}`);
    return [];
  }
}

interface FinalRow {
  repo: string;
  prNumber: number;
  headSha: string;
  runner: string | null;
  model: string | null;
  reasoningEffort: string | null;
  status: string;
  commentId: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

function trackedPrs(db: Db, notes: string[]): PrRow[] {
  try {
    // Newest-first within each PR so the first row seen per group is the latest.
    const rows = db
      .prepare(
        `SELECT repo, pr_number AS prNumber, head_sha AS headSha, runner, model,
                reasoning_effort AS reasoningEffort, status, comment_id AS commentId,
                error, started_at AS startedAt, finished_at AS finishedAt
           FROM review_runs
          WHERE status IN ('ok','skipped','error')
          ORDER BY repo ASC, pr_number ASC, COALESCE(finished_at, started_at) DESC`,
      )
      .all() as FinalRow[];

    const byKey = new Map<string, PrRow>();
    for (const r of rows) {
      const key = `${r.repo}#${r.prNumber}`;
      const existing = byKey.get(key);
      if (!existing) {
        // First row for this PR == the latest run.
        byKey.set(key, {
          repo: r.repo,
          prNumber: r.prNumber,
          headSha: r.headSha,
          rounds: 1,
          posted: r.commentId != null ? 1 : 0,
          lastStatus: r.status,
          lastRunner: r.runner,
          lastModel: r.model,
          lastReasoningEffort: r.reasoningEffort,
          lastCommentId: r.commentId,
          lastError: r.error,
          lastAt: r.finishedAt ?? r.startedAt,
          findingsBySeverity: null,
        });
      } else {
        existing.rounds += 1;
        if (r.commentId != null) existing.posted += 1;
      }
    }
    return [...byKey.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  } catch (e) {
    notes.push(`prs unavailable: ${msg(e)}`);
    return [];
  }
}

function queueCounts(db: Db, notes: string[]): QueueCounts {
  try {
    const rows = db
      .prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`)
      .all() as Array<{ status: string; n: number }>;
    const q = emptyQueue();
    for (const { status, n } of rows) {
      if (status === "queued") q.enqueued = n;
      else if (status === "running") q.inFlight = n;
      else if (status === "done") q.done = n;
      else if (status === "skipped") q.skipped = n;
      else if (status === "error") q.error = n;
      else if (status === "dead_letter") q.deadLetter = n;
    }
    return q;
  } catch (e) {
    notes.push(`queue unavailable: ${msg(e)}`);
    return emptyQueue();
  }
}

interface ErrRow {
  repo: string;
  prNumber: number;
  headSha: string;
  runner: string | null;
  model: string | null;
  error: string;
  at: string;
}

function recentErrors_(db: Db, notes: string[]): RecentError[] {
  try {
    const rows = db
      .prepare(
        `SELECT repo, pr_number AS prNumber, head_sha AS headSha, runner, model, error,
                COALESCE(finished_at, started_at) AS at
           FROM review_runs
          WHERE status = 'error' AND error IS NOT NULL
          ORDER BY COALESCE(finished_at, started_at) DESC
          LIMIT 12`,
      )
      .all() as ErrRow[];
    return rows.map((r) => ({
      repo: r.repo,
      prNumber: r.prNumber,
      headSha: r.headSha,
      runner: r.runner,
      model: r.model,
      error: r.error,
      kind: RATE_LIMIT_RE.test(r.error) ? "rate_limit" : "error",
      at: r.at,
    }));
  } catch (e) {
    notes.push(`recent errors unavailable: ${msg(e)}`);
    return [];
  }
}

function emptyQueue(): QueueCounts {
  return { enqueued: 0, inFlight: 0, done: 0, skipped: 0, error: 0, deadLetter: 0 };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
