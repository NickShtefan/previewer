# Config And Contracts Guide

This file applies to `src/config/` (and the `src/core/` interfaces it pairs with).

## Scope

The contract layer. `src/config/schema/` holds the zod schemas that define every
on-disk format (platform config, repo config, the context pack, runner
capabilities/profiles, review/state types) and are the single source of truth for
shape. `src/config/` also holds the loaders and the runner-profile resolution.
`src/core/` holds the behavioral interfaces (`Store`, `Queue`, `Runner`,
`ContextProvider`, `Publisher`, `GitHubClient`, `RunnerRegistry`, `PackGenerator`)
and stays implementation-free.

## Files That Matter

- `schema/platform.ts`: `PlatformConfig` (paths, reconciler cadence, GitHub App
  pointers, `runnerProfiles`).
- `schema/repo.ts`: `RepoConfig` (events, review, the `runner` block with
  `profile`/`default`/`overrides`, publish, context, security).
- `schema/pack.ts`: the pack schemas (`PackManifest`/`Provenance`, `Routing`,
  `Profiles`, `Invariant`, `SecurityBaseline`, `SubsystemGuide`, `ContextPack`).
- `schema/runner.ts`: `RunnerCapabilities`, `RunnerProfile(s)`,
  `DEFAULT_RUNNER_PROFILES`, `RunnerSelector`.
- `index.ts`: `loadPlatformConfig` (resolves paths to absolute), `loadRepoConfig`,
  `listRepoConfigs`, `setRepoRunnerProfile`.
- `runner-profiles.ts`: `resolveRunnerProfile` + profile validation.

## Core Invariants

### Config carries secret pointers, never secret values

- Only `privateKeyPath` (a `.pem` outside the repo) and `webhookSecretEnv` (an env
  var name). No token, key, cookie, or webhook secret in any committed YAML, pack,
  or code.

### Schemas are the source of truth; new fields are backward compatible

- YAML keys are camelCase and equal the zod keys. A new field needs a default so
  existing `repo.yaml` / `platform.yaml` keep loading. A schema change without a
  matching update to the `config/repos/_example` pack and its tests is a finding
  (the example doubles as a fixture).

### Filesystem paths resolve to absolute

- `loadPlatformConfig` resolves `dataDir`/`dbPath`/`reposDir`/`workspacesDir` to
  absolute. A relative `workspacesDir` was resolved twice by the codex runner (cwd
  plus `-C`) and produced a doubled, nonexistent path. Keep them absolute.

### Runner-profile resolution precedence

- `runner.profile` (a named `{runner, model, reasoningEffort}` bundle) supersedes
  the inline `runner.default`/`model`/`reasoningEffort`. `listRepoConfigs` skips
  `_`/`.`-prefixed dirs (so `_example` is a template, never a live repo). Every
  profile must target a registered runner id.

### An unrunnable repo config is a value, not an exception

- "Registered" and "usable" are different sets, and every operator-facing surface must
  use the same one: `usableRunnerIds` / `runnerUnusable` back the config check, the CLI's
  `runner list` / `runner use`, and the suggestion list inside a rejection message. A
  rejection that names a stub among the valid ids sends the operator back into the failure.
- The check takes registered runners' **capabilities**, not their ids: a stub
  (`implemented: false`) has a perfectly valid id, and "resolves to a registered id"
  is exactly the test it passes. `runner.default` also has a zod fallback, so a
  repo.yaml that loses its `profile:` line silently resolves to a value nobody wrote —
  if that value is a stub, an id-only check waves it through and the review dies after
  claiming, with no run row (#33).
- `runnerConfigProblem` / `repoRunnerProblems` answer "can this repo be reviewed?"
  without throwing, so the platform can report it at startup, the dashboard can show
  it, and the pipeline can fail the review BEFORE it claims anything.
  `resolveRunnerProfile` still throws for callers that want that; what must not come
  back is a resolution failure surfacing for the first time mid-review, after the
  claim — that stranded the claim and silently lost the head (kourion.fi, 2026-08).

### `src/core` stays implementation-free

- The interfaces declare behavior only. No concrete class, no octokit/sqlite import.
  Config must not import `src/core` (it throws plain Errors instead) to avoid an
  import cycle.

## Review Focus

When reviewing changes here, check:

1. Does any new field hold a secret value inline instead of a path or env-var name?
2. Is a new schema field defaulted so existing config keeps loading, and is the
   `_example` pack + fixtures updated alongside?
3. Do platform paths stay absolute after load?
4. Does profile resolution still let `runner.profile` win over the inline block, and
   reject profiles targeting an unregistered runner?
5. Did an interface in `src/core` gain an implementation detail?

## Validation

- `npm test -- tests/runner-profiles.test.ts tests/fixtures.test.ts`
