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
  lease_id: string | null;
  locked_at: string | null;
  visible_at: string;
  created_at: string;
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    repo: r.repo,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    baseSha: r.base_sha ?? undefined,
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
}

/** Build a fresh queued Job (generates id + createdAt). */
export function makeJob(input: MakeJobInput, clock: Clock = systemClock): Job {
  return {
    id: randomUUID(),
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
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

  constructor(db: Db, opts: SqliteQueueOptions = {}) {
    this.db = db;
    this.now = opts.clock ?? systemClock;
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  async init(): Promise<void> {
    migrate(this.db);
  }

  async enqueue(job: Job): Promise<"enqueued" | "duplicate"> {
    const info = this.db
      .prepare(
        `INSERT INTO jobs
           (id, repo, pr_number, head_sha, base_sha, source, status, attempts, lease_id, locked_at, visible_at, created_at)
         VALUES (@id, @repo, @pr, @sha, @base, @source, 'queued', 0, NULL, NULL, @ts, @created)
         ON CONFLICT(repo, pr_number, head_sha) DO NOTHING`,
      )
      .run({
        id: job.id,
        repo: job.repo,
        pr: job.prNumber,
        sha: job.headSha,
        base: job.baseSha ?? null,
        source: job.source,
        ts: iso(this.now()),
        created: job.createdAt,
      });
    return info.changes === 1 ? "enqueued" : "duplicate";
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

  async nack(leaseId: string, retryInMs: number): Promise<void> {
    const run = this.db.transaction((): void => {
      const row = this.db.prepare(`SELECT * FROM jobs WHERE lease_id=?`).get(leaseId) as
        | JobRow
        | undefined;
      if (!row) return; // stale lease

      if (row.attempts >= this.maxAttempts) {
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

  /** Inspection helper (not part of the Queue interface) — used by tests/CLI. */
  getByKey(repo: string, prNumber: number, headSha: string): Job | null {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE repo=? AND pr_number=? AND head_sha=?`)
      .get(repo, prNumber, headSha) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }
}
