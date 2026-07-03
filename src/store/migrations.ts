import type { Db } from "./db";

/** Idempotent schema bootstrap. One SQLite file holds queue + state + audit. */
export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      github_delivery_id TEXT PRIMARY KEY,
      received_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id         TEXT PRIMARY KEY,
      repo       TEXT NOT NULL,
      pr_number  INTEGER NOT NULL,
      head_sha   TEXT NOT NULL,
      base_sha   TEXT,
      source     TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'queued',
      attempts   INTEGER NOT NULL DEFAULT 0,
      lease_id   TEXT,
      locked_at  TEXT,
      visible_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(repo, pr_number, head_sha)
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_leasable ON jobs(status, visible_at);

    CREATE TABLE IF NOT EXISTS review_runs (
      id          TEXT PRIMARY KEY,
      repo        TEXT NOT NULL,
      pr_number   INTEGER NOT NULL,
      head_sha    TEXT NOT NULL,
      base_sha    TEXT,
      runner      TEXT,
      model       TEXT,
      reasoning_effort TEXT,
      profile     TEXT,
      status      TEXT NOT NULL,
      comment_id  INTEGER,
      tokens_in   INTEGER NOT NULL DEFAULT 0,
      tokens_out  INTEGER NOT NULL DEFAULT 0,
      usd         REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error       TEXT,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE(repo, pr_number, head_sha)
    );
  `);

  // Idempotent column adds for DBs created before a column existed. SQLite has no
  // ADD COLUMN IF NOT EXISTS, so gate on PRAGMA table_info.
  addColumnIfMissing(db, "review_runs", "reasoning_effort", "TEXT");
}

/** Add `column` to `table` only if it isn't already present (idempotent migration). */
function addColumnIfMissing(db: Db, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
