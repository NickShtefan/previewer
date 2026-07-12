# Reconciler Guide

This file applies to `src/apps/reconciler/`.

## Scope

The completeness safety net. It lists open non-draft PRs across enabled repos,
finds head SHAs with no successful review, enqueues them through the same durable
queue webhooks use, and optionally drains. This is the correctness guarantee:
webhooks are a latency optimization, the reconciler is what makes review coverage
independent of webhook delivery, so the machine can be off for a week and catch up
from state plus GitHub metadata.

## Files That Matter

- `reconcile.ts`: `reconcile()` + `ReconcileDeps`/`ReconcileOptions`. The sweep.
- `main.ts`: the scheduler (run on start + every N hours from platform config).

Coverage decisions come from `Store.isReviewedOrInFlight`
(`src/store/sqlite-store.ts`); draining reuses `drainQueue` from
`src/apps/worker/loop.ts`.

## Core Invariants

### The sweep is metadata-only until an uncovered SHA is found

- Listing PRs and checking coverage spends zero model tokens. Cost is incurred only
  when an uncovered SHA is enqueued and processed. `dryRun` reports uncovered PRs
  and enqueues nothing.

### Coverage respects in-flight work and limit cooldowns

- A head is skipped when it is terminally reviewed (ok/skipped), has a live claim
  (`running` within the stale window, e.g. a forced review mid-flight), or hit a
  recent limit-classified error still cooling down. A stale `running` (dead worker)
  and non-limit errors are NOT covered, so they still get retried. This is what
  prevents duplicate codex spend.

### It converges on the same queue and dedupe key

- Enqueue goes through the shared queue with the `(repo, pr, head_sha)` dedupe, so
  the reconciler can never create a review path only it can trigger, and never
  bypasses the dedupe.

## Review Focus

When reviewing changes here, check:

1. Does the sweep still cost zero tokens until an uncovered SHA is processed?
2. Does coverage still treat a stale `running` and non-limit errors as retriable
   (not covered), while treating live claims and cooling limit errors as covered?
3. Does an intake change introduce state the reconciler cannot reconstruct from
   GitHub metadata?
4. Does enqueue still respect the dedupe key (no force-bypass in the sweep path)?

## Validation

- `npm test -- tests/reconcile.test.ts`
