# Worker Guide

This file applies to `src/apps/worker/`.

## Scope

The review pipeline: one PR head SHA in, one review comment (and one audit row)
out. It orchestrates every other seam through interfaces and owns the strict
ordering that keeps reviews idempotent and cheap. It knows no model internals and
no GitHub internals: it calls `Store`, `GitHubClient`, `WorkspaceProvider`,
`ContextProvider`, `RunnerRegistry`, and `Publisher`.

## Files That Matter

- `pipeline.ts`: `reviewPipeline` (the whole ordered flow) + `ReviewRequest`.
- `gate.ts`: the pure pre-model gate (`gate()`), skips no-op / ignored-only diffs.
- `policy.ts`: `changeSignals` + `selectRunnerSelector` (which runner/model/effort).
- `workspace.ts`: `WorkspaceProvider` / `PreparedWorkspace` (checkout + diff + cleanup).
- `install.ts`: opt-in dependency install in the worktree when a repo runs tests.
- `loop.ts`: `drainQueue` (lease -> run -> ack/nack) shared by worker and reconciler.
  A thrown pipeline error (e.g. a GitHub 5xx HTML page breaking JSON.parse) is caught
  and classified (`classifyFailure`): transient -> `nackTransient` (back-off, no
  dead-letter), permanent -> `nack`. It never escapes to strand the job or abort the drain.

## Core Invariants

### The order is fixed and claim precedes spend

- PR meta -> `claimReview` -> workspace/diff -> gate -> resolve context -> select
  runner -> review -> publish -> `recordRun`. `claimReview` always runs before any
  runner is selected or spent.

### Dry-run has zero side effects

- `req.dryRun` skips `claimReview`, publishing, and `recordRun`, and returns right
  after the runner call. No audit/metric write may sneak onto this path.

### Gate before model

- `gate()` runs immediately after diff prep. An empty or ignored-only diff skips
  cheaply and is recorded as `status=skipped` (so the reconciler stops re-enqueuing
  it), before any context resolution, install, or runner selection.

### Incremental vs full, and forced re-review

- Incremental mode reviews `lastReviewedSha..head`; `req.full` (from `/rereview`)
  ignores `lastReviewedSha` so the diff is `base..head`. A closed PR, or a draft
  when the repo ignores drafts, is skipped.

### runTests is triple-gated, and workspaces always clean up

- Tests run only when the repo enabled `review.runTests` AND resolved tests exist
  AND an active profile sets `runTests`. The worktree is torn down in a `finally`,
  so no leaked worktrees even on error.

### Runner/model/effort resolution precedence

- CLI flags > repo.yaml policy/profile > runner default. A CLI-forced `--runner`
  ignores config-resolved model/effort (those target the policy-selected runner,
  which may differ); only an explicit flag applies then.

## Review Focus

When reviewing changes here, check:

1. Does any reordering move context resolution, install, or runner selection ahead
   of the gate or ahead of `claimReview`?
2. Does a new state write execute on the `dryRun` path?
3. Does `runTests` widen outside its three gates?
4. Is the workspace still cleaned up on every exit path?
5. Does forced-full handling still bypass incremental correctly?

## Validation

- `npm test -- tests/pipeline.test.ts tests/gate-policy.test.ts tests/incremental-fallback.test.ts tests/runner.test.ts`
- `npm test -- tests/install.test.ts` when touching dependency install.
