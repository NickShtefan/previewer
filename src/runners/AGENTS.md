# Runners Guide

This file applies to `src/runners/`.

## Scope

This subtree is the only place previewer spawns a model. It holds the runner
registry and the concrete backends behind the `core/Runner` and `core/PackGenerator`
seams:

- the CLI runners: `claude -p` (Claude Code, default) and `codex exec` (OpenAI
  Codex), both agentic and billed to the operator's subscription;
- their onboarding counterparts (`ClaudeCliPackGenerator`, `CodexPackGenerator`)
  that author pack artifacts from a checkout;
- the shared review/onboarding prompt builders and the model-output/envelope
  parsing that maps raw CLI output back into `ReviewResult` / pack artifacts;
- an injectable `CliExecutor` so every runner is testable offline with canned
  output.

A runner turns a `ReviewInput` into a `ReviewResult` and nothing else. It must not
import GitHub, queue, or store code.

## Files That Matter

- `registry.ts`: `RunnerRegistry` (`register`/`get`/`select`/`all`) and policy
  selection by cost/quality/change-signals.
- `cli/executor.ts`: `nodeExecutor` (spawn), `sanitizedClaudeEnv()`,
  `sanitizedCodexEnv()`. The env-hygiene chokepoint.
- `cli/claude.ts`: `ClaudeCliRunner` (review). Builds `claude -p` args, retries on
  output drift, prefers the JSON envelope error over exit code.
- `cli/codex.ts`: `CodexCliRunner` (review). `codex exec --json` with an output
  schema; preloads a bounded workspace-context bundle as a starting point.
- `cli/onboard.ts`: `ClaudeCliPackGenerator` + `CodexPackGenerator` (pack authoring).
- `cli/workspace-context.ts`: bounded changed-file context collection for codex.
- `shared/prompt.ts`, `shared/output.ts`, `shared/model-output.schema.json`: the
  shared review prompt, onboarding prompt, and envelope/stream parsers.
- `api/anthropic.ts`: the API-runner option (swappable behind the same contract).

## Core Invariants

### Every spawned `claude -p` passes `--strict-mcp-config`

- Present in both `cli/claude.ts` (review) and `cli/onboard.ts` (generation), with
  no `--mcp-config`, so zero MCP/channel servers start.
- The documented reason (the telegram long-poll hijack, PR #16) lives in the
  comment block above the args in both files. Do not drop the flag or the comment.

### Child processes never inherit the raw parent environment

- Review and generation exec calls pass `sanitizedClaudeEnv()` / `sanitizedCodexEnv()`
  (via `cleanEnv`, default true). `claude` keeps `CLAUDE_CODE_OAUTH_TOKEN`; `codex`
  drops `OPENAI_*` so it stays on the ChatGPT subscription, not a paid key.

### Review stays read-only unless the repo opted into tests

- Default allowed tools are Read/Grep/Glob (claude) and `--sandbox read-only`
  (codex). `Bash` (claude) / `workspace-write` (codex) are granted only when
  `ctx.runTests` is set. No edits, no network.

### Output drift is retried; real errors are not

- A missing JSON envelope is transient output drift (especially Fable) and is
  retried up to `maxParseAttempts`. A parsed error envelope (auth/limit) or a
  thrown exec is returned immediately, never retried into the same failure.

### The runner is a leaf of the DI graph

- No imports from `src/github`, `src/store`, or `src/apps`. `result.reviewedHeadSha`
  echoes the input head SHA. Adding a backend is adding an adapter, not reaching
  into the platform.

## Review Focus

When reviewing changes here, check:

1. Does any spawn path build args without `--strict-mcp-config` (claude) or leak
   the raw env?
2. Could `codex` bill a paid `OPENAI_API_KEY` instead of the subscription?
3. Does read-only widen to Bash/workspace-write outside the `ctx.runTests` gate?
4. Does error surfacing still prefer the JSON envelope over the exit code (auth and
   limit errors ride a non-zero exit)?
5. Does the runner reach past its contract into GitHub/queue/store?

High-severity findings here are usually a dropped `--strict-mcp-config`, raw-env
inheritance, or a read-only sandbox silently widened.

## Validation

- `npm test -- tests/cli-runner.test.ts tests/codex-runner.test.ts tests/cli-error-capture.test.ts tests/limit-error.test.ts`
- `npm test -- tests/runner.test.ts` when registry selection is involved.
- Tests must keep spawning the injected `CliExecutor` fake, never the real
  `claude`/`codex` and never the network.
