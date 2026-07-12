# Subsystem: config

**Path:** `src/config` · **Risk:** high

The contract layer. `schema/` holds the zod schemas that define every on-disk format and are the single source of truth for shape; `config/` holds the loaders and runner-profile resolution. The paired `src/core/` interfaces stay implementation-free.

## Files that matter

- `schema/platform.ts`, `schema/repo.ts`, `schema/pack.ts`, `schema/runner.ts`: the formats.
- `index.ts`: `loadPlatformConfig` (resolves paths to absolute), `loadRepoConfig`, `listRepoConfigs`, `setRepoRunnerProfile`.
- `runner-profiles.ts`: `resolveRunnerProfile` + profile validation.

## Invariants to enforce

- Config carries secret pointers, never values: only `privateKeyPath` (a `.pem` outside the repo) and `webhookSecretEnv` (an env var name). No token/key/cookie/webhook secret in any committed YAML, pack, or code. Critical.
- Schemas are the source of truth; YAML keys are camelCase and equal the zod keys. A new field needs a default so existing `repo.yaml`/`platform.yaml` keep loading. A schema change without matching `config/repos/_example` pack + test updates is a finding (the example doubles as a fixture).
- Filesystem paths resolve to absolute in `loadPlatformConfig` (a relative `workspacesDir` was resolved twice by the codex runner and broke it).
- `runner.profile` (a named bundle) supersedes the inline `runner.default`/`model`/`reasoningEffort`; every profile must target a registered runner id; `listRepoConfigs` skips `_`/`.`-prefixed dirs.
- `src/core` interfaces stay implementation-free; config must not import `src/core` (avoids an import cycle).

## Review focus

Flag any config field holding a secret value inline, an undefaulted new schema field (or one missing the `_example`/fixture update), a platform path left relative, broken profile-resolution precedence, or an implementation detail leaking into a `src/core` interface.

Validation: `npm test -- tests/runner-profiles.test.ts tests/fixtures.test.ts`.
