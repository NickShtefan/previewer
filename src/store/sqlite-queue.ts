import { randomUUID } from "node:crypto";
import type { Queue, LeasedJob } from "../core";
import type { Job, JobSource, JobStatus } from "../config";
import { migrate } from "./migrations";
import { systemClock, iso, type Clock, type Db } from "./db";

interface JobRow {
  id: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  base_sha: string | null;
  source: string;
  status: string;
  attempts: number;
  transient_attempts: number;
  lease_id: string | null;
  locked_at: string | null;
  visible_at: string;
  created_at: string;
  full_review: number;
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    repo: r.repo,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    baseSha: r.base_sha ?? undefined,
    full: r.full_review === 1,
    source: r.source as JobSource,
    status: r.status as JobStatus,
    attempts: r.attempts,
    lockedAt: r.locked_at,
    createdAt: r.created_at,
  };
}

export interface MakeJobInput {
  repo: string;
  prNumber: number;
  headSha: string;
  source: JobSource;
  baseSha?: string;
  /** Force a full (base..head) review, bypassing incremental (used by /rereview). */
  full?: boolean;
}

/** Build a fresh queued Job (generates id + createdAt). */
export function makeJob(input: MakeJobInput, clock: Clock = systemClock): Job {
  return {
    id: randomUUID(),
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
    full: input.full ?? false,
    source: input.source,
    status: "queued",
    attempts: 0,
    lockedAt: null,
    createdAt: iso(clock()),
  };
}

export interface SqliteQueueOptions {
  maxAttempts?: number;
  clock?: Clock;
  /** Base delay for the first transient retry (doubles each retry). Default 60s. */
  transientBaseMs?: number;
  /** Ceiling for the transient exponential back-off. Default 30min. */
  transientCapMs?: number;
}

/**
 * Durable job queue with at-least-once delivery and visibility-timeout leases.
 * A job is leasable when status is queued/running AND its visibility window has
 * elapsed, so a crashed worker's lease auto-expires and the job is retried.
 */
export class SqliteQueue implements Queue {
  private readonly db: Db;
  private readonly now: Clock;
  private readonly maxAttempts: number;
  private readonly transientBaseMs: number;
  private readonly transientCapMs: number;

  constructor(db: Db, opts: SqliteQueueOptions = {}) {
    this.db = db;
    this.now = opts.clock ?? systemClock;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.transientBaseMs = opts.transientBaseMs ?? 60_000;
    this.transientCapMs = opts.transientCapMs ?? 1_800_000;
  }

  async init(): Promise<void> {
    migrate(this.db);
  }

  async enqueue(job: Job, opts: { force?: boolean } = {}): Promise<"enqueued" | "duplicate" | "requeued"> {
    const run = this.db.transaction((): "enqueued" | "duplicate" | "requeued" => {
      const nowIso = iso(this.now());
      const inserted = this.db
        .prepare(
          `INSERT INTO jobs
             (id, repo, pr_number, head_sha, base_sha, source, status, attempts, lease_id, locked_at, visible_at, created_at, full_review)
           VALUES (@id, @repo, @pr, @sha, @base, @source, 'queued', 0, NULL, NULL, @ts, @created, @full)
           ON CONFLICT(repo, pr_number, head_sha) DO NOTHING`,
        )
        .run({
          id: job.id,
          repo: job.repo,
          pr: job.prNumber,
          sha: job.headSha,
          base: job.baseSha ?? null,
          source: job.source,
          ts: nowIso,
          created: job.createdAt,
          full: job.full ? 1 : 0,
        });
      if (inserted.changes === 1) return "enqueued";
      if (!opts.force) return "duplicate";
      // Forced re-review (human /rereview): reset the existing head row so a completed or
      // leased job is picked up again — clear the lease and make it immediately visible.
      this.db
        .prepare(
          `UPDATE jobs
              SET status='queued', attempts=0, transient_attempts=0, lease_id=NULL, locked_at=NULL,
                  visible_at=@ts, source=@source, full_review=@full
            WHERE repo=@repo AND pr_number=@pr AND head_sha=@sha`,
        )
        .run({
          ts: nowIso,
          source: job.source,
          full: job.full ? 1 : 0,
          repo: job.repo,
          pr: job.prNumber,
          sha: job.headSha,
        });
      return "requeued";
    });
    return run();
  }

  async lease(visibilityTimeoutMs: number): Promise<LeasedJob | null> {
    const run = this.db.transaction((): LeasedJob | null => {
      const nowIso = iso(this.now());
      const row = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE status IN ('queued','running') AND visible_at <= @now
           ORDER BY created_at ASC, id ASC LIMIT 1`,
        )
        .get({ now: nowIso }) as JobRow | undefined;
      if (!row) return null;

      const leaseId = randomUUID();
      const visibleAt = iso(new Date(this.now().getTime() + visibilityTimeoutMs));
      this.db
        .prepare(
          `UPDATE jobs SET status='running', lease_id=@lease, locked_at=@now, visible_at=@vis,
             attempts=attempts+1 WHERE id=@id`,
        )
        .run({ lease: leaseId, now: nowIso, vis: visibleAt, id: row.id });

      const job = rowToJob(row);
      return {
        ...job,
        status: "running",
        attempts: row.attempts + 1,
        lockedAt: nowIso,
        leaseId,
      };
    });
    return run();
  }

  async ack(leaseId: string): Promise<void> {
    // Only the current lease-holder can ack; a stale lease (after re-lease) is a no-op.
    this.db
      .prepare(`UPDATE jobs SET status='done', lease_id=NULL, locked_at=NULL WHERE lease_id=?`)
      .run(leaseId);
  }

  async nack(leaseId: string, retryInMs: number, opts: { maxAttempts?: number } = {}): Promise<void> {
    const cap = opts.maxAttempts ?? this.maxAttempts;
    const run = this.db.transaction((): void => {
      const row = this.db.prepare(`SELECT * FROM jobs WHERE lease_id=?`).get(leaseId) as
        | JobRow
        | undefined;
      if (!row) return; // stale lease

      if (row.attempts >= cap) {
        this.db
          .prepare(`UPDATE jobs SET status='dead_letter', lease_id=NULL, locked_at=NULL WHERE id=?`)
          .run(row.id);
      } else {
        const visibleAt = iso(new Date(this.now().getTime() + retryInMs));
        this.db
          .prepare(
            `UPDATE jobs SET status='queued', lease_id=NULL, locked_at=NULL, visible_at=? WHERE id=?`,
          )
          .run(visibleAt, row.id);
      }
    });
    run();
  }

  async nackTransient(leaseId: string): Promise<void> {
    const run = this.db.transaction((): void => {
      const row = this.db.prepare(`SELECT * FROM jobs WHERE lease_id=?`).get(leaseId) as
        | JobRow
        | undefined;
      if (!row) return; // stale lease

      // A transient failure (GitHub/engine outage, throttle, network) must survive an
      // arbitrarily long outage, so it never dead-letters: instead of the `attempts`
      // budget, grow a separate `transient_attempts` counter and derive an exponential
      // back-off from it. Undo the lease-time `attempts++` so these retries never push
      // the job toward maxAttempts — only genuine (permanent) failures spend that budget.
      const transientAttempts = row.transient_attempts + 1;
      const visibleAt = iso(new Date(this.now().getTime() + this.transientBackoffMs(transientAttempts)));
      const attempts = Math.max(0, row.attempts - 1);
      this.db
        .prepare(
          `UPDATE jobs
              SET status='queued', lease_id=NULL, locked_at=NULL,
                  visible_at=@vis, attempts=@attempts, transient_attempts=@transient
            WHERE id=@id`,
        )
        .run({ vis: visibleAt, attempts, transient: transientAttempts, id: row.id });
    });
    run();
  }

  /** Exponential back-off for the nth transient retry (n>=1): base*2^(n-1), capped. */
  private transientBackoffMs(n: number): number {
    const scaled = this.transientBaseMs * 2 ** Math.max(0, n - 1);
    return Math.min(scaled, this.transientCapMs);
  }

  async nextVisibleAt(): Promise<Date | null> {
    const nowIso = iso(this.now());
    // Mirrors lease's leasability condition: the next moment a job becomes leasable.
    const row = this.db
      .prepare(
        `SELECT MIN(visible_at) AS next FROM jobs
          WHERE status IN ('queued','running') AND visible_at > @now`,
      )
      .get({ now: nowIso }) as { next: string | null } | undefined;
    return row?.next ? new Date(row.next) : null;
  }

  /** Inspection helper (not part of the Queue interface) — used by tests/CLI. */
  getByKey(repo: string, prNumber: number, headSha: string): Job | null {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE repo=? AND pr_number=? AND head_sha=?`)
      .get(repo, prNumber, headSha) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }
}
