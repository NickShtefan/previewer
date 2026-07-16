# Store Guide

This file applies to `src/store/`.

## Scope

Durable state in one SQLite file: the `Store` (dedupe facts, run/audit records,
webhook delivery idempotency) and the `Queue` (at-least-once delivery with
visibility-timeout leases and dead-lettering). This is where every idempotency
guarantee is physically enforced, by UNIQUE constraints and `INSERT .. ON CONFLICT`
rather than by application checks.

## Files That Matter

- `sqlite-store.ts`: `SqliteStore` (`claimReview`, `recordRun`, `lastReviewedSha`,
  `isReviewed`, `isReviewedOrInFlight`, delivery dedupe, audit rollups).
- `sqlite-queue.ts`: `SqliteQueue` (`enqueue`, `lease`, `ack`, `nack`, `nackTransient`) + `makeJob`.
- `migrations.ts`: idempotent schema bootstrap + `addColumnIfMissing`.
- `db.ts`: the `Db`/`Clock` seams and the `better-sqlite3` handle.

## Core Invariants

### Dedupe keys on `(repo, pr_number, head_sha)`

- `jobs` and `review_runs` both carry `UNIQUE(repo, pr_number, head_sha)`. Claims
  and enqueues use `ON CONFLICT`. `claimReview` inserts a `running` placeholder that
  `recordRun` later finalizes, so the dedupe row and the audit row are the same row.

### claimReview is the atomic gate before spend

- A claim succeeds only for a fresh key, a prior `error` run, or a stale `running`
  (older than the ~15 min window); `force` reclaims regardless. `info.changes === 1`
  means claimed, else duplicate. A live `running` claim is treated as covered.

### The queue survives crashes

- `lease` flips a visible job to `running` with a new lease id and bumps `attempts`;
  a crashed worker's lease auto-expires (visibility timeout) and the job is retried.
  `ack` and `nack` only affect the current lease-holder (a stale lease is a no-op).
  `nack` dead-letters after `maxAttempts`, else re-queues with backoff. Forced
  `/rereview` re-queues an existing head row. `nackTransient` is the outage path:
  it re-queues with exponential back-off (base 60s, capped 30min) off a separate
  `transient_attempts` counter and never dead-letters, so a long GitHub/engine
  outage retries indefinitely instead of burning the `attempts` budget.

### Migrations are additive and safe against production data

- Schema bootstrap is `CREATE TABLE IF NOT EXISTS`; new columns go through
  `addColumnIfMissing` (gated on `PRAGMA table_info`, since SQLite has no
  `ADD COLUMN IF NOT EXISTS`). Never a destructive migration against an existing
  `data/orchestrator.db`.

## Review Focus

When reviewing changes here, check:

1. Does any change weaken a `UNIQUE(repo, pr_number, head_sha)` constraint or bypass
   `ON CONFLICT`?
2. Is there a window where a crash produces a double-review or a lost claim?
3. Does the coverage logic in `isReviewedOrInFlight` still distinguish live claims
   and cooling limit errors (covered) from stale/dead runs and non-limit errors
   (retriable)?
4. Is a new migration additive and idempotent?

## Validation

- `npm test -- tests/store.test.ts`
- `npm test -- tests/limit-error.test.ts` when touching limit classification.
