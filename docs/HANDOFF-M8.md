# Handoff prompt — implement M8 (repo onboarding)

> Paste this to a fresh agent, or tell it: "Read `docs/HANDOFF-M8.md` and implement M8."

---

You are continuing work on **previewer**, a working autonomous AI PR-review orchestrator at
`/Users/nikolayshkolenko/Projects/CODE/PReviewer`. Milestones **M0–M7 are done** (64 tests, type-checked,
proven live on a real PR). Your job: implement **M8 — repo onboarding**.

## First, orient yourself (read these)

1. `README.md` — what the product is and how it runs.
2. `docs/ARCHITECTURE.md` — esp. **§7 context pack**, **§8 use-existing vs generate**, **§9 onboarding pipeline**, **§17 code map**.
3. `docs/MILESTONES.md` — the **M8** section (goal, scope, acceptance criteria).
4. Memory files (auto-loaded; key ones): `previewer-project`, `kourion-reference`, `prefer-subscription-cli-runner`.
5. Skim the code map below.

**The reference repo:** `~/Projects/CODE/kourion.fi` (branch `codex/pr-reviewer-playbook`) is a real,
hand-authored context layer — the **gold standard for what onboarding should ingest/produce**: a root +
nested `AGENTS.md` hierarchy, `docs/reviewer/` (`routing.yaml`, `profiles/*.md`, `comment-template.md`),
and `docs/invariants/*.md`. Its normalized form already lives in `config/repos/_example/context-pack/`.
Onboarding kourion is your best end-to-end validation.

## What M8 must do

Implement `OnboardingPipeline.run()` (currently a stub at `src/context/onboarding.ts` that throws
`NotImplementedError`) + a CLI `onboard <owner/repo>` command. Pipeline stages:

1. **Acquire** — get a checkout. Support `--local <path>` (use it directly) and clone-to-cache
   (reuse `src/github/git.ts` `ensureCheckout` / `worktree.ts`). Default: a read-only checkout/worktree.
2. **Inventory** (deterministic, cheap — no model): detect languages, package managers, frameworks, CI
   config, test framework + command, entrypoints, and top-level module/dir boundaries. Produce
   `Inventory` (schema in `src/config/schema/onboarding.ts`). Light static analysis + dir scan.
3. **Discover** existing context: scan for `README`, `CLAUDE.md`, `AGENTS.md` (root + nested), `docs/`,
   ADRs, `CONTRIBUTING`, `.cursorrules`, and a `docs/reviewer/` layer. Record what was found.
4. **Assess** per artifact (rubric → `ContextAssessment`: coverage/specificity/freshness/security/
   machineUsability, 0..1). `freshness` = do referenced files/symbols still exist (cheap check).
5. **Decide** per artifact (NOT whole-repo): `ingest` (≥ threshold), `augment`, or `generate`
   (`ArtifactDecision`). `useExistingThreshold` comes from `OnboardingInput` (default 0.7).
6. **Generate** missing/weak artifacts **via the runner** (the agentic `claude -p` runner already reads
   the repo) — produce: `repo-guide.md`, `subsystems/*.md`, `routing.yaml`, `profiles.yaml`,
   **proposed** `invariants.yaml`, `security-baseline.yaml` (universal + repo-specific), `comment-template.md`,
   optional `risk-map.yaml`. See "Generation" below.
7. **Human-confirm gate** — generated **invariants** get `status: needs_confirmation` (never auto-enforce
   hallucinated rules). Surface them in `OnboardingResult.openQuestions`. The CLI reports them and (if you
   add it) can mark them confirmed via a follow-up flag.
8. **Persist** — write the pack to `config/repos/<owner>__<name>/context-pack/` and a `manifest.yaml`
   with per-artifact **`Provenance`** (`source` ingested/augmented/generated, `from`, `model`,
   `confidence`, `approvedBy`) + sha256 of each artifact. Also write/update `repo.yaml` if absent.
   Return `OnboardingResult` (schema present).

## Key existing pieces to reuse (don't reinvent)

- **Schemas (source of truth):** `src/config/schema/onboarding.ts` (`OnboardingInput`, `OnboardingResult`,
  `Inventory`, `Module`, `ContextAssessment`, `ArtifactDecision`) and `src/config/schema/pack.ts`
  (`ContextPack`, `PackManifest`, `Routing`, `Profiles`, `Invariants`, `SecurityBaseline`, `SubsystemGuide`,
  `RiskMap`, `Provenance`).
- **Pack reading:** `src/context/pack.ts` `loadPack(dir, repoId)`. **You must add the inverse —
  `writePack(dir, pack)`** that serializes a `ContextPack` to the on-disk files via `yaml.stringify` +
  markdown, and computes manifest sha256s. There is no writer yet.
- **Routing/resolve:** `src/context/routing.ts` (so you know the exact `routing.yaml`/`profiles.yaml`
  shapes you must emit — additive routes, profiles bundle `docs` + `tests`).
- **Runner:** `src/runners/` — `ClaudeCliRunner` (`src/runners/cli/claude.ts`) is the default, agentic,
  on the user's subscription, **env already sanitized** for auth. Its pattern: build a prompt
  (`shared/prompt.ts`), spawn via an injectable `CliExecutor` (`cli/executor.ts`), parse the JSON
  envelope (`shared/output.ts`). The `Runner` interface has an **optional `onboard?(input, ctx)`** method.
- **Git/fs:** `src/github/git.ts` (`ensureCheckout`, `ensureSha`, `gitDiff`, `mergeBaseSafe`),
  `src/github/worktree.ts` (`addWorktree`, non-destructive).
- **Wiring:** `src/compose.ts` (`composePlatform`, `composeReviewDeps`) — follow its style for an
  `composeOnboarding()` that builds the runner + paths from `config/platform.yaml`.
- **CLI:** `src/apps/cli/main.ts` — `onboard` is currently a "scaffolded, not implemented" case. Wire it
  (arg/flag parsing helpers already there: `parseArgs`, `str`).
- **Example to match:** `config/repos/_example/` (the kourion-normalized pack) is exactly the output shape
  you should produce.

## Generation (how to use the model)

Recommended: implement generation as one (or a few) **runner call(s)**. Mirror `ClaudeCliRunner.review`:
build an *onboarding prompt* that hands the model the inventory + discovered docs + the **target pack
schema** and asks it to read the repo (it runs in the checkout) and emit the artifacts as a single
strict JSON object you parse with a zod schema and then `writePack`. Two clean options:

- **(a)** Add `ClaudeCliRunner.onboard()` (implements the optional `Runner.onboard`) returning the pack
  artifacts; the pipeline calls `runner.onboard(input, ctx)`.
- **(b)** Keep generation inside `OnboardingPipeline` using the same `CliExecutor` seam directly.

Either way: **make it testable by injecting the runner/executor** (so unit tests pass canned artifacts —
never call real `claude`). Keep generation token-bounded (onboarding reads a whole repo): cap `max-turns`,
prefer the inventory/discovered docs over exhaustive reading, and ingest (not regenerate) anything that
already scores high.

## Acceptance criteria

- `npm run cli -- onboard <owner>/<repo> [--local <path>]` produces a **valid `context-pack@v1`**
  (it must pass `loadPack`) + an `OnboardingResult` (status, inventory, decisions, provenance, openQuestions, cost).
- A repo with a good `CLAUDE.md`/`AGENTS.md`/`docs/reviewer/` → some artifacts `ingested` (provenance shows it).
- Generated invariants are `needs_confirmation`.
- **Live validation:** `onboard NickShtefan/kourion.fi --local ~/Projects/CODE/kourion.fi` ingests its
  AGENTS.md hierarchy + `docs/reviewer/` + `docs/invariants/` into a valid pack (compare with `_example`).
- New tests: `tests/onboarding.test.ts` — mocked runner + a temp git repo; assert inventory detection,
  ingest-vs-generate decisions, `writePack` round-trips through `loadPack`, and `OnboardingResult` shape.

## How to work (project conventions)

- Single-package TypeScript (strict), **zod is the source of truth** for formats, YAML keys camelCase,
  `tsx` runs TS directly (no build). Node 22.
- **Testability via injected seams** — unit tests are offline: `:memory:` SQLite, temp dirs for git, and
  **mock the runner/executor**. Study `tests/pipeline.test.ts`, `tests/runner.test.ts`,
  `tests/reconcile.test.ts` for the fake-deps pattern.
- Per-milestone loop: implement → `npx tsc --noEmit` (clean) → `npm test` (all green) → update
  `docs/MILESTONES.md` (mark **M8 ✅** + a status block), `docs/ARCHITECTURE.md` (§17 code-map row),
  and the memory index → **commit** with a `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.
  (Commit only when the work is green; the user has been committing each milestone.)
- Respond to the user in **Russian** (code/identifiers in English) — see the `user-language` memory.

## Gotchas (learned the hard way)

- **claude auth:** must be a standalone subscription login, not borrowed from a Claude Code session (the
  runner sanitizes env to handle this). For tests, **mock the runner — never call real `claude`**.
- **GitHub token:** if you need it, read `GITHUB_TOKEN` env; **never** pass `--token` on the command line
  (npm echoes it and leaks the token). Onboarding can be **fully local** (`--local`, no token) for inventory/
  discover/generate — only persisting + reviewing later needs GitHub.
- **Don't clobber** an existing pack blindly — support re-onboarding: bump `manifest.version`, keep
  `confirmed` invariants, diff against the previous pack.
- Keep onboarding **cheap** (the user cares about token usage): ingest where possible, bound generation.

## Current code map (for reference)

```
src/config/schema/   zod schemas (onboarding.ts, pack.ts are the ones you need)
src/context/         pack.ts (loadPack — add writePack), routing.ts, provider.ts, onboarding.ts (STUB → fill)
src/runners/         cli/claude.ts (claude -p), cli/executor.ts, shared/{prompt,output}.ts, registry.ts
src/github/          git.ts, worktree.ts (checkout/diff helpers)
src/compose.ts       composition roots (add composeOnboarding)
src/apps/cli/main.ts onboard command (wire it)
config/repos/_example/  the target pack shape
tests/               64 tests; add onboarding.test.ts
```

Build it the way the rest of the project is built: small, typed, tested, committed. Good luck.
