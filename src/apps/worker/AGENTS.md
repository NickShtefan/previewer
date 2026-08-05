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
- `policy.ts`: `changeSignals` + `selectRunnerSelector` (which runner/model/effort)
  + `turnBudget` (how many agent turns this diff is worth).
- `workspace.ts`: `WorkspaceProvider` / `PreparedWorkspace` (checkout + diff + cleanup).
- `diff-budget.ts`: `capPatch` — bounds the inline diff to whole file sections.
- `install.ts`: opt-in dependency install in the worktree when a repo runs tests.
- `loop.ts`: `drainQueue` (lease -> run -> ack/nack) shared by worker and reconciler.
  A thrown pipeline error (e.g. a GitHub 5xx HTML page breaking JSON.parse) is caught
  and classified 3-way (`classifyFailure`): transient -> `nackTransient` (back-off, no
  dead-letter); permanent (known 4xx/auth) -> `nack` on the normal budget; unknown
  (unrecognised) -> journaled in detail ("unclassified failure" via the platform logger)
  then `nack` on a small bounded budget (default 3). It never escapes to strand the job
  or abort the drain.

## Core Invariants

### The order is fixed and claim precedes spend

- PR meta -> `claimReview` -> workspace/diff -> gate -> resolve context -> select
  runner -> review -> publish -> `recordRun`. `claimReview` always runs before any
  runner is selected or spent.

### Config is checked before the claim, and a config failure never dead-letters

- `reviewPipeline` runs `runnerConfigProblem` first — before `claimReview`, before the
  GitHub call. An unresolvable runner used to throw from mid-run, leaving a 'running' row
  that made every retry a no-op "duplicate" and lost the head. The returned error carries
  `CONFIG_ERROR_PREFIX`, which `classifyFailure` treats as transient: retrying is free
  (nothing claimed, nothing spent) and self-heals when the config is fixed, whereas
  dead-lettering would lose every PR pushed during the misconfiguration — the queue dedupes
  on head SHA, so a dead-lettered job is never re-enqueued.
- An explicit `--runner` skips config resolution entirely (both the precheck and
  `selectRunnerSelector`), so the manual override still works while the config is broken.

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

### The inline diff is capped, and the cap is disclosed

- `buildReviewInput` runs the patch through `capPatch` at `min(review.maxPatchChars,
  maxTokensPerRun * 3)`. Sections are dropped whole — a patch cut mid-hunk reads like a
  complete change and produces a confidently wrong verdict. Dropped paths travel in
  `ReviewInput.diff.omittedFiles`, stay in `changedFiles` (routing still sees them), and
  the prompt names them so the agentic runner opens them in the checkout and reports
  anything it did not read as not reviewed. Silently shrinking the diff instead would
  turn a partial review into one that looks complete.

### The agent's turn budget scales with the diff

- `ctx.budget.maxTurns` comes from `turnBudget(changedFiles.length)`, not a constant. A fixed
  cap loses the entire review on a large PR: the agent spends every turn opening files and
  returns nothing (`error_max_turns`, kourion.fi#754 on 2026-08-05 — no comment posted, then
  four identical retries). The floor keeps small PRs cheap; the ceiling stops a runaway PR from
  eating an unbounded slice of the subscription. A runner may fall back to its own default when
  the caller supplies no budget, but must not ignore one that is supplied.

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

- `npm test -- tests/pipeline.test.ts tests/gate-policy.test.ts tests/incremental-fallback.test.ts tests/runner.test.ts tests/diff-budget.test.ts`
- `npm test -- tests/install.test.ts` when touching dependency install.
