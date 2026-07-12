# Previewer Agent Guide

## Product

Previewer is an autonomous, context-aware, multi-repo AI pull-request reviewer you
run on your own machine. Core promises:

- watch GitHub PRs and, the moment one opens or updates, post exactly one plain
  top-level review comment tuned to that repo's architecture and invariants;
- catch real regressions (broken cross-file contracts, privacy leaks, weakened
  auth, data-provenance bugs), not style nits;
- always apply a mandatory security/privacy/risk lens, regardless of the change;
- run on the operator's Claude or ChatGPT subscription via an agentic CLI, with no
  per-token API bill by default;
- never double-post and never miss a PR.

When making tradeoffs, correctness of the review verdict, idempotency (no
double-spend, no spam), operator-secret safety, and subscription-first auth matter
more than convenience or cosmetic cleanup.

## Repo Map

- `src/core/`: behavioral interfaces only (the contract layer). No implementations.
  `Store`, `Queue`, `Runner`, `ContextProvider`, `Publisher`, `GitHubClient`,
  plus `RunnerRegistry` and `PackGenerator`.
- `src/config/`: zod schemas for every on-disk format (`schema/`) + loaders +
  runner-profile resolution. The single source of truth for config shape.
- `src/store/`: SQLite `Store` + `Queue` (dedupe, leases, retry/dead-letter).
- `src/github/`: PAT/App auth, HMAC webhook verify, checkout/diff/worktree,
  idempotent single-comment publish.
- `src/context/`: context-pack load + additive routing + the onboarding pipeline
  (inventory, discover, assess, generate, write).
- `src/runners/`: the runner registry and the CLI runners (`claude -p`, `codex
  exec`) plus their onboarding pack-generators. The only place a model is spawned.
- `src/apps/`: the executables. `cli/` (review/reconcile-now/onboard/runner/inspect),
  `worker/` (the review pipeline), `reconciler/` (completeness sweep), `ingress/`
  (webhook HTTP server), `dashboard/` (read-only LAN status page).
- `src/compose.ts`: the composition root. Wires concrete implementations to the
  `src/core` interfaces from platform + repo config and env.
- `config/`: `platform.yaml` + per-repo `repos/<owner>__<name>/` (repo.yaml +
  context-pack/). `config/repos/_example/` is the worked-example pack and doubles
  as a test fixture.
- `docs/`: `ARCHITECTURE.md` (declared source of truth for design), `MILESTONES.md`,
  `EVENT-DRIVEN.md`.
- `data/`: runtime only, gitignored. SQLite DB + cloned PR workspaces under
  `data/workspaces/`. Never source; onboarding must never ingest it.

Scoped guidance lives in nested `AGENTS.md` files under `src/runners/`,
`src/context/`, `src/store/`, `src/github/`, `src/config/`, and each
`src/apps/<app>/`. When working in those trees, follow the nested file as the more
specific instruction set.

## Dev Commands

- Typecheck: `npm run typecheck` (tsc --noEmit)
- Tests: `npm test` (vitest, deterministic and offline)
- Watch tests: `npm run test:watch`
- CLI: `npm run cli -- <command>` (`review`, `reconcile-now`, `onboard`,
  `runner list|use`, `inspect`)
- Long-running apps: `npm run ingress`, `npm run worker`, `npm run reconciler`,
  `npm run dashboard`

There is no build step: `tsx` runs the TypeScript directly. Prefer the narrowest
relevant test file for a touched area; the per-subsystem `AGENTS.md` lists them,
and `context-pack/profiles.yaml` maps changed paths to test commands.

## Architecture Summary

Previewer is dependency-injected on purpose. `src/core/interfaces.ts` and
`src/core/runner.ts` declare pure behavioral seams; concrete classes live in
`src/store`, `src/github`, `src/context`, and `src/runners`; `src/compose.ts` is
the only place they are wired together.

Two foundational rules make the design work:

- The worker knows no model and the runner knows no GitHub. The review pipeline
  (`src/apps/worker/pipeline.ts`) orchestrates through interfaces; a `Runner` only
  turns a `ReviewInput` into a `ReviewResult`. This is what makes model backends
  swappable with zero worker changes.
- Webhooks are a latency optimization; the reconciler is the correctness
  guarantee. Both intake paths converge on the same durable SQLite queue, and all
  dedupe keys on `(repo, pr_number, head_sha)`, so completeness never depends on a
  webhook being delivered.

Request flow: PR event -> ingress (verify + filter + enqueue) or reconciler sweep
-> durable queue -> worker (claim -> workspace/diff -> gate -> resolve context ->
select runner -> review -> publish one comment -> record). Only the narrowed slice
of the context pack for the changed files ever reaches the model.

## Hard Invariants

### 1. Every spawned model CLI passes `--strict-mcp-config`

- Both the review runner (`src/runners/cli/claude.ts`) and the onboarding
  generator (`src/runners/cli/onboard.ts`) must spawn `claude -p` with
  `--strict-mcp-config` and no `--mcp-config`, so it loads zero MCP/channel
  servers.
- Without it a spawned `claude` inherits the operator's config dir and auto-starts
  enabled channel plugins; the telegram plugin's poller then hijacks the live
  session's long-poll on the same bot token (HTTP 409) and drops the operator's
  Telegram MCP. This hit production on 2026-07-12 (fixed in PR #16).

Review priority: any new or refactored CLI spawn path (shared arg builder, new
runner) that omits the flag on one call site is a critical finding.

### 2. Child CLIs get a sanitized environment, never the raw parent env

- `claude` children use `sanitizedClaudeEnv()` (strips `ANTHROPIC_API_KEY`/
  `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`/`CLAUDECODE` and `CLAUDE_CODE_*`, but
  keeps `CLAUDE_CODE_OAUTH_TOKEN`). `codex` children use `sanitizedCodexEnv()`
  (strips `OPENAI_*`). Both live in `src/runners/cli/executor.ts`.
- Two failure modes this prevents: a child inheriting a parent's host-managed
  session gets unrecoverable 401s; a leaked API key silently converts a
  subscription-billed run into a paid API bill.

Review priority: flag any exec that passes the raw environment on an auth-bearing
path, and any change to the strip/keep lists that drops `CLAUDE_CODE_OAUTH_TOKEN`.

### 3. Webhook HMAC verification fails closed

- Every webhook request is rejected with 401 unless `X-Hub-Signature-256` verifies
  via constant-time comparison. An empty secret or a missing signature must fail
  closed. Verification is the first step in `handleWebhook`, before any parsing or
  state read.

Review priority: ingress is the only network-exposed surface and it enqueues work
that spends tokens and posts to GitHub. Any change that replaces `timingSafeEqual`
with a string compare, makes the empty-secret case pass, or moves verification
after parsing is a critical finding.

### 4. Comment-triggered re-reviews require write access

- `/rereview` (and `@previewer rereview`) act only on `action=created` comments on
  PRs whose `author_association` is OWNER, MEMBER, or COLLABORATOR. Edited comments
  and CONTRIBUTOR/NONE authors are silently ignored.

Review priority: accepting `edited` events (an edit can retroactively inject a
command into an old comment) or widening the allowed associations lets an arbitrary
commenter burn the operator's tokens. High severity.

### 5. Exactly one top-level comment per head SHA

- Publishing is an upsert of one comment located by the hidden marker
  `<!-- ai-review:{repo}#{pr}@{head_sha} -->`. Never a blind post, never the GitHub
  formal-review API. A rerun for the same SHA edits the prior comment; a new SHA
  gets a fresh one.

Review priority: any publish path that posts without first searching for the
marker, or drops the marker from the body, or switches to formal reviews, breaks
idempotency layer 4 and spams PRs.

### 6. All dedupe keys on `(repo, pr_number, head_sha)`

- Jobs, review claims, and `review_runs` key on this triple, enforced by UNIQUE
  indexes and `INSERT .. ON CONFLICT`. `claimReview` happens before any runner
  spend. SHA granularity makes force-push/rebase produce a new key automatically
  and makes retries free of double-posts.

Review priority: any schema/query change that weakens the UNIQUE constraint or
bypasses `ON CONFLICT`, or any path that runs a runner before `claimReview`
returns non-duplicate, is a correctness/cost regression.

### 7. Dry-run has zero side effects

- A `dryRun` review skips `claimReview`, publishing, and `recordRun` entirely, so
  the operator can re-run it freely. It returns before the publish/record block.

Review priority: any new state write (audit, metrics, telemetry-to-store) that
executes on the dry-run path poisons dedupe state and could post to real PRs during
testing.

### 8. The cheap gate runs before any runner is selected or spent

- The path-based gate (no changed files, or only `ignorePaths` matched) runs
  immediately after diff preparation and can skip before context resolution,
  dependency install, or runner selection. Gate skips are recorded as
  `status=skipped` so the reconciler does not re-enqueue them forever.

### 9. The security baseline is always resolved, and the pack never goes whole

- `resolveContext` always includes the security baseline and
  `defaults.mandatoryProfiles` regardless of which routes match, and returns only
  the narrowed slice for the changed files. It must never inline the full pack.

Review priority: a routing/resolve change that makes the security baseline
conditional, or that inlines all subsystems/invariants, breaks both the safety
guarantee and the cost model. High severity.

### 10. Pack cross-references are validated and packs round-trip

- Every profile referenced by routing (`routes.activateProfiles` and
  `defaults.mandatoryProfiles`) must be defined in `profiles.yaml`; `loadPack`
  keeps throwing `ConfigError` on a dangling reference. `writePack` output must
  round-trip back through `loadPack`.

Review priority: a hand-edited pack under `config/repos/*/context-pack` that
references an undefined profile makes the repo unreviewable; a silently-accepted
dangling reference drops review coverage.

### 11. Generated invariants stay `needs_confirmation` until a human approves

- Machine-generated invariants and security-baseline additions default to
  `status: needs_confirmation` and must not be flipped to `confirmed` (or
  auto-enforced) without human approval recorded in provenance.

Review priority: any onboarding/generation change that sets `status=confirmed` or
`approvedBy` on artifacts a human never saw, or a pack edit that flips statuses
without a corresponding sign-off in the PR.

### 12. Config YAML carries secret pointers, never secret values

- Config holds only `privateKeyPath` (a path to a `.pem` outside the repo) and
  `webhookSecretEnv` (an env var name). Packs and code contain no tokens or keys.
  `config/` is committed and packs are designed to be shareable.

Review priority: any config field that holds a secret value inline, or any
committed file under `config/repos/` that embeds a token/cookie/webhook secret, is
a critical finding.

### 13. Runners talk to the platform only through the review contract

- A `Runner` never imports GitHub, queue, or store code; it turns a `ReviewInput`
  into a `ReviewResult`, and `result.reviewedHeadSha` must echo `input.headSha`.
  Adding a backend means adding an adapter only.

Review priority: a runner importing from `src/github`, `src/store`, or `src/apps`
breaches the boundary the whole architecture rests on.

### 14. The dashboard escapes every dynamic value

- Every dynamic value inserted into the DOM passes `esc()`, and any server-derived
  string embedded into the inline-JS template literal is escaped for
  newlines/backticks/interpolation. Repo names, PR titles, and raw runner error
  bodies are attacker-influenced.

Review priority: any field concatenated into `innerHTML` without `esc()`, or a
multi-line string reaching the inline `<script>` unescaped, is an XSS or a
JS-breaking bug (a raw newline in `errBody` once broke all dashboard JS, PR #13).

### 15. The reconciler guarantees completeness independent of webhooks

- The sweep finds any uncovered open-PR head SHA from GitHub metadata alone and
  enqueues it through the same queue path webhooks use. It spends zero model tokens
  until an uncovered SHA is found and respects the dedupe key.

Review priority: any intake change that creates a review path only webhooks can
trigger (state the reconciler cannot reconstruct) breaks the correctness
guarantee.

## Schema And Config Rules

- The zod schemas in `src/config/schema/` are the single source of truth. YAML keys
  are camelCase and equal the zod keys.
- New config fields need defaults so existing `config/repos/*/repo.yaml` and
  `config/platform.yaml` keep loading (backward compatibility).
- A schema change in `src/config/schema/**` without matching updates to the
  `config/repos/_example` pack and tests is a finding: the example pack doubles as
  the routing (M3) and onboarding-ingest (M8) fixture.
- SQLite migrations are additive and idempotent (`ADD COLUMN` gated on
  `PRAGMA table_info`); they must stay safe against an existing production
  `data/orchestrator.db`.
- `package.json` / `package-lock.json` changes get the supply-chain lens: previewer
  runs unattended with GitHub credentials and spawns CLIs with the operator's
  environment.

## Review Workflow

When reviewing a PR, in order:

1. Identify the touched subsystem (runners, ingress, worker, reconciler, dashboard,
   context/onboarding, store, github, config/core) and read that subsystem's
   `AGENTS.md`.
2. Check whether any hard invariant above is at risk.
3. Read adjacent code, not just the diff. Regressions here come from breaking a
   cross-file contract (an interface boundary, a dedupe key, a spawn-arg property),
   not a local syntax slip.
4. Run the narrowest relevant tests (the subsystem guide and `profiles.yaml` list
   them).
5. Report findings in severity order: operator-secret/auth safety, review
   idempotency and double-spend, correctness of the verdict, then polish.

`docs/ARCHITECTURE.md` is the declared source of truth for design; a code-behavior
change should not silently contradict it.

## Change Guidance For Agents

- Prefer extending an existing seam over introducing a parallel path around an
  interface. If a seam lacks a symbol, add it to that seam.
- Preserve invariant comments; many document prior production incidents (the
  `--strict-mcp-config` block, the doubled-path codex fix) and are not noise.
- Do not reach around the DI boundary (worker importing a concrete runner, a runner
  importing octokit).
- Never commit anything under `data/`, and never put a secret value in `config/`.

If unsure, bias toward: idempotency over convenience; subscription-first auth over
inherited sessions; fail-closed over permissive intake; a narrowed context slice
over sending the whole pack.
