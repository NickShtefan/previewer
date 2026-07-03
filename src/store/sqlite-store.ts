import { randomUUID } from "node:crypto";
import type { Store } from "../core";
import type { ReviewKey, ReviewRun } from "../config";
import { migrate } from "./migrations";
import { systemClock, iso, type Clock, type Db } from "./db";

/** A finalized run row, shaped for reporting (CLI `inspect`). */
export interface RunRow {
  repo: string;
  prNumber: number;
  headSha: string;
  runner: string | null;
  model: string | null;
  status: string;
  commentId: number | null;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  durationMs: number;
  startedAt: string;
  finishedAt: string | null;
}

/** Per-repo audit rollup (CLI `inspect`). */
export interface RepoStats {
  repo: string;
  runs: number;
  ok: number;
  error: number;
  skipped: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  lastAt: string;
}

/**
 * Durable state: dedupe (one review per repo+pr+head_sha), audit/run records,
 * and webhook delivery idempotency. The `review_runs` table is both the dedupe
 * row and the audit record — claimReview inserts a 'running' placeholder that
 * recordRun later finalizes.
 */
export class SqliteStore implements Store {
  private readonly db: Db;
  private readonly now: Clock;

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.now = clock;
  }

  async init(): Promise<void> {
    migrate(this.db);
  }

  async claimReview(
    key: ReviewKey,
    opts: { force?: boolean; staleMs?: number } = {},
  ): Promise<"claimed" | "duplicate"> {
    const staleMs = opts.staleMs ?? 15 * 60 * 1000;
    const staleBefore = iso(new Date(this.now().getTime() - staleMs));
    const info = this.db
      .prepare(
        `INSERT INTO review_runs (id, repo, pr_number, head_sha, status, started_at)
         VALUES (@id, @repo, @pr, @sha, 'running', @ts)
         ON CONFLICT(repo, pr_number, head_sha) DO UPDATE SET
           id = excluded.id, status = 'running', started_at = excluded.started_at,
           finished_at = NULL, error = NULL
         WHERE @force = 1
            OR review_runs.status = 'error'
            OR (review_runs.status = 'running' AND review_runs.started_at < @stale)`,
      )
      .run({
        id: randomUUID(),
        repo: key.repo,
        pr: key.prNumber,
        sha: key.headSha,
        ts: iso(this.now()),
        force: opts.force ? 1 : 0,
        stale: staleBefore,
      });
    return info.changes === 1 ? "claimed" : "duplicate";
  }

  async recordRun(run: ReviewRun): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO review_runs
           (id, repo, pr_number, head_sha, base_sha, runner, model, reasoning_effort, profile, status,
            comment_id, tokens_in, tokens_out, usd, duration_ms, error, started_at, finished_at)
         VALUES
           (@id, @repo, @pr, @sha, @base, @runner, @model, @effort, @profile, @status,
            @commentId, @tin, @tout, @usd, @dur, @error, @started, @finished)
         ON CONFLICT(repo, pr_number, head_sha) DO UPDATE SET
           base_sha=excluded.base_sha, runner=excluded.runner, model=excluded.model,
           reasoning_effort=excluded.reasoning_effort,
           profile=excluded.profile, status=excluded.status, comment_id=excluded.comment_id,
           tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out, usd=excluded.usd,
           duration_ms=excluded.duration_ms, error=excluded.error, finished_at=excluded.finished_at`,
      )
      .run({
        id: run.id,
        repo: run.repo,
        pr: run.prNumber,
        sha: run.headSha,
        base: run.baseSha ?? null,
        runner: run.runner ?? null,
        model: run.model ?? null,
        effort: run.reasoningEffort ?? null,
        profile: run.profile ?? null,
        status: run.status,
        commentId: run.commentId ?? null,
        tin: run.tokensIn,
        tout: run.tokensOut,
        usd: run.usd,
        dur: run.durationMs,
        error: run.error ?? null,
        started: run.startedAt,
        finished: run.finishedAt ?? null,
      });
  }

  async lastReviewedSha(repo: string, prNumber: number): Promise<string | null> {
    const row = this.db
      .prepare(
        `SELECT head_sha FROM review_runs
         WHERE repo=? AND pr_number=? AND status IN ('ok','skipped','error')
         ORDER BY COALESCE(finished_at, started_at) DESC LIMIT 1`,
      )
      .get(repo, prNumber) as { head_sha: string } | undefined;
    return row?.head_sha ?? null;
  }

  async isReviewed(repo: string, prNumber: number, headSha: string): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM review_runs
         WHERE repo=? AND pr_number=? AND head_sha=? AND status IN ('ok','skipped') LIMIT 1`,
      )
      .get(repo, prNumber, headSha);
    return row !== undefined;
  }

  async seenDelivery(deliveryId: string): Promise<boolean> {
    const row = this.db
      .prepare(`SELECT 1 AS x FROM deliveries WHERE github_delivery_id=?`)
      .get(deliveryId);
    return row !== undefined;
  }

  async markDelivery(deliveryId: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO deliveries (github_delivery_id, received_at) VALUES (?, ?)
         ON CONFLICT(github_delivery_id) DO NOTHING`,
      )
      .run(deliveryId, iso(this.now()));
  }

  // --- reporting (CLI `inspect`) — read-only audit queries ------------------

  /** Most recent runs, newest first; optionally filtered to one repo. */
  async listRuns(opts: { repo?: string; limit?: number } = {}): Promise<RunRow[]> {
    const params: Record<string, unknown> = { limit: opts.limit ?? 20 };
    let where = "";
    if (opts.repo) {
      where = "WHERE repo = @repo";
      params.repo = opts.repo;
    }
    return this.db
      .prepare(
        `SELECT repo, pr_number AS prNumber, head_sha AS headSha, runner, model, status,
                comment_id AS commentId, tokens_in AS tokensIn, tokens_out AS tokensOut, usd,
                duration_ms AS durationMs, started_at AS startedAt, finished_at AS finishedAt
           FROM review_runs ${where}
          ORDER BY COALESCE(finished_at, started_at) DESC
          LIMIT @limit`,
      )
      .all(params) as RunRow[];
  }

  /** Per-repo rollup of run counts, tokens, and cost. */
  async aggregateByRepo(): Promise<RepoStats[]> {
    return this.db
      .prepare(
        `SELECT repo,
                COUNT(*) AS runs,
                SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS error,
                SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped,
                SUM(tokens_in) AS tokensIn,
                SUM(tokens_out) AS tokensOut,
                SUM(usd) AS usd,
                MAX(COALESCE(finished_at, started_at)) AS lastAt
           FROM review_runs
          GROUP BY repo
          ORDER BY runs DESC`,
      )
      .all() as RepoStats[];
  }
}
