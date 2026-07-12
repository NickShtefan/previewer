# Subsystem: store

**Path:** `src/store` · **Risk:** high

Durable state in one SQLite file: the `Store` (dedupe, run/audit records, delivery idempotency) and the `Queue` (at-least-once delivery with visibility-timeout leases and dead-lettering). Every idempotency guarantee is physically enforced by UNIQUE constraints and `INSERT .. ON CONFLICT`, not application checks.

## Files that matter

- `sqlite-store.ts`: `SqliteStore` (`claimReview`, `recordRun`, `lastReviewedSha`, `isReviewed`, `isReviewedOrInFlight`, delivery dedupe, audit rollups).
- `sqlite-queue.ts`: `SqliteQueue` (`enqueue`, `lease`, `ack`, `nack`) + `makeJob`.
- `migrations.ts`: idempotent bootstrap + `addColumnIfMissing`. `db.ts`: the `Db`/`Clock` seams.

## Invariants to enforce

- Dedupe on `(repo, pr_number, head_sha)`: `jobs` and `review_runs` both carry `UNIQUE(repo, pr_number, head_sha)`; claims/enqueues use `ON CONFLICT`. `claimReview` inserts a `running` placeholder that `recordRun` finalizes (the dedupe row is the audit row).
- `claimReview` is the atomic gate before spend: it succeeds only for a fresh key, a prior `error`, or a stale `running` (older than ~15 min); `force` reclaims regardless. A live `running` is covered.
- The queue survives crashes: `lease` bumps `attempts` and sets a visibility timeout so a crashed worker's lease auto-expires; `ack`/`nack` affect only the current lease-holder; `nack` dead-letters after `maxAttempts` else re-queues with backoff.
- Migrations are additive and idempotent (`CREATE TABLE IF NOT EXISTS`, `addColumnIfMissing` gated on `PRAGMA table_info`), safe against an existing `data/orchestrator.db`.

## Review focus

Flag any change that weakens a UNIQUE constraint or bypasses `ON CONFLICT`, opens a crash window that double-reviews or loses a claim, breaks the covered-vs-retriable logic in `isReviewedOrInFlight`, or ships a destructive migration.

Validation: `npm test -- tests/store.test.ts tests/limit-error.test.ts`.
