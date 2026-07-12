# Subsystem: context

**Path:** `src/context` · **Risk:** high

Two jobs behind `core/ContextProvider`: serve reviews (load a repo's pack and resolve the narrow slice a PR needs via additive routing) and build packs (the onboarding pipeline: inventory, discover, assess, generate, write).

## Files that matter

- `pack.ts`: `loadPack` / `writePack` (the inverse pair) + subsystem parse/serialize + cross-ref validation.
- `routing.ts`: `resolveContext` (additive routing) + `globMatch`.
- `onboarding.ts`: the `OnboardingPipeline` orchestrator. `provider.ts`: the `ContextProvider`.
- `inventory.ts`: deterministic repo inventory. `discover.ts`: existing-context discovery. `assess.ts`: the ingest/generate rubric.
- `fs-scan.ts`: `walkFiles` + `IGNORE_DIRS` (the single walk both discover and inventory use).

## Invariants to enforce

- Onboarding never walks into `data/`: `IGNORE_DIRS` includes `data` alongside `node_modules`/`.git`/`dist`. `data/` is the previewer's runtime tree (SQLite + `data/workspaces/<owner>__<repo>/` checkouts); ingesting it emits other repos' AGENTS.md as previewer subsystems and their top dirs as modules. Fix belongs in `IGNORE_DIRS`, not per call site.
- Security baseline is always resolved and the pack is never sent whole: `resolveContext` seeds active profiles from `defaults.mandatoryProfiles` and always includes the baseline; subsystems/invariants are filtered by changed paths; only a narrowed slice is returned.
- `loadPack` throws `ConfigError` on a dangling profile reference or a missing/invalid required artifact; `writePack` recomputes sha256, drops stale subsystems, and emits markdown that parses back.
- Generated invariants stay `needs_confirmation` (never auto-enforced); re-onboarding bumps the version and preserves confirmed invariants.

## Review focus

Flag any new file walk that bypasses `walkFiles`/`IGNORE_DIRS`, a resolve change that makes the baseline conditional or inlines the whole pack, a `writePack` format change that no longer round-trips, or onboarding that confirms an invariant without human approval.

Validation: `npm test -- tests/routing.test.ts tests/onboarding.test.ts tests/onboard-discovery-data-exclusion.test.ts tests/fixtures.test.ts`.
