# Subsystem: reconciler

**Path:** `src/apps/reconciler` · **Risk:** medium

The completeness safety net. Lists open non-draft PRs across enabled repos, finds head SHAs with no successful review, enqueues them through the same durable queue webhooks use, and optionally drains. Webhooks are latency; the reconciler is the correctness guarantee.

## Files that matter

- `reconcile.ts`: `reconcile()` + `ReconcileDeps`/`ReconcileOptions` (the sweep).
- `main.ts`: the scheduler (on start + every N hours).

Coverage comes from `Store.isReviewedOrInFlight`; draining reuses `drainQueue` from the worker.

## Invariants to enforce

- The sweep is metadata-only: listing PRs and checking coverage spends zero model tokens; cost is incurred only when an uncovered SHA is processed. `dryRun` enqueues nothing.
- Coverage respects in-flight work: skip terminally reviewed heads, a live claim (forced review mid-flight), or a recent limit error still cooling down; a stale `running` (dead worker) and non-limit errors are NOT covered and still get retried. This prevents duplicate codex spend.
- Enqueue goes through the shared queue with the `(repo, pr, head_sha)` dedupe: the reconciler never creates a review path only it can trigger and never bypasses the dedupe.

## Review focus

Flag any change that spends tokens before an uncovered SHA is processed, mis-classifies stale/dead runs as covered, force-bypasses the dedupe in the sweep, or introduces state the reconciler cannot reconstruct from GitHub metadata.

Validation: `npm test -- tests/reconcile.test.ts`.
