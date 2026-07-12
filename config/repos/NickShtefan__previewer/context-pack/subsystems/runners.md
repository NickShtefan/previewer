# Subsystem: runners

**Path:** `src/runners` · **Risk:** high

The only place a model is spawned: the runner registry and the CLI runners (`claude -p`, `codex exec`) plus their onboarding pack-generators, behind the `core/Runner` and `core/PackGenerator` seams.

## Files that matter

- `cli/executor.ts`: `nodeExecutor`, `sanitizedClaudeEnv()`, `sanitizedCodexEnv()` (env-hygiene chokepoint).
- `cli/claude.ts`: `ClaudeCliRunner` (review) - builds `claude -p` args, retries on output drift.
- `cli/codex.ts`: `CodexCliRunner` (review) - `codex exec --json` with an output schema.
- `cli/onboard.ts`: `ClaudeCliPackGenerator` + `CodexPackGenerator` (pack authoring).
- `registry.ts`: `RunnerRegistry` and policy selection.
- `shared/`: review/onboarding prompts + envelope/stream parsers.

## Invariants to enforce

- Every spawned `claude -p` passes `--strict-mcp-config` with no `--mcp-config` (both `cli/claude.ts` and `cli/onboard.ts`), so zero MCP/channel servers start. A missing flag caused a live telegram long-poll hijack (PR #16). Critical.
- Child processes never inherit the raw parent env: `sanitizedClaudeEnv()` (keeps `CLAUDE_CODE_OAUTH_TOKEN`) / `sanitizedCodexEnv()` (drops `OPENAI_*`), gated by `cleanEnv` (default true).
- Review is read-only (claude Read/Grep/Glob; codex `--sandbox read-only`); Bash / workspace-write only when `ctx.runTests`.
- Output drift (no JSON envelope) is retried up to `maxParseAttempts`; a parsed error envelope or a thrown exec is returned immediately, never retried.
- A runner imports no GitHub/queue/store code; `result.reviewedHeadSha` echoes `input.headSha`.

## Review focus

Flag any spawn path that omits `--strict-mcp-config`, leaks the raw env, could bill a paid `OPENAI_API_KEY`, widens the sandbox outside the `ctx.runTests` gate, or reaches past the runner contract into the platform.

Validation: `npm test -- tests/cli-runner.test.ts tests/codex-runner.test.ts tests/cli-error-capture.test.ts tests/limit-error.test.ts`.
