# Subsystem: worker

**Path:** `src/apps/worker` · **Risk:** high

The review pipeline: one PR head SHA in, one review comment (and one audit row) out. Orchestrates every seam through interfaces and owns the strict ordering that keeps reviews idempotent and cheap. Knows no model or GitHub internals.

## Files that matter

- `pipeline.ts`: `reviewPipeline` (the ordered flow) + `ReviewRequest`.
- `gate.ts`: the pure pre-model gate.
- `policy.ts`: `changeSignals` + `selectRunnerSelector`.
- `workspace.ts`: checkout + diff + cleanup. `install.ts`: opt-in worktree deps. `loop.ts`: `drainQueue`.

## Invariants to enforce

- Fixed order, claim before spend: PR meta -> `claimReview` -> workspace/diff -> gate -> resolve context -> select runner -> review -> publish -> `recordRun`.
- Dry-run has zero side effects: `req.dryRun` skips claim, publish, and record and returns right after the runner call.
- Gate before model: an empty or ignored-only diff skips cheaply and is recorded `status=skipped`, before context resolution/install/runner selection.
- Incremental reviews `lastReviewedSha..head`; `req.full` (/rereview) forces `base..head`. Closed PRs and (config-gated) drafts skip.
- `runTests` is triple-gated (repo opted in AND resolved tests exist AND an active profile sets `runTests`); the worktree is always cleaned up in `finally`.
- Resolution precedence: CLI flags > repo.yaml policy/profile > runner default; a CLI-forced `--runner` ignores config-resolved model/effort.

## Review focus

Flag any reordering that moves work ahead of the gate or `claimReview`, a state write on the dry-run path, `runTests` widening outside its gates, a leaked worktree, or broken forced-full handling.

Validation: `npm test -- tests/pipeline.test.ts tests/gate-policy.test.ts tests/incremental-fallback.test.ts tests/runner.test.ts`.
