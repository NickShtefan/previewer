# Context And Onboarding Guide

This file applies to `src/context/`.

## Scope

Two related jobs behind the `core/ContextProvider` seam:

- serve reviews: load a repo's on-disk context pack and resolve the narrow slice a
  PR needs (additive routing) so the model never receives the whole pack;
- build packs: the onboarding pipeline that inventories a checkout, discovers
  existing context, assesses per artifact whether to ingest or generate, calls a
  `PackGenerator` for the structured pieces, and writes the pack with provenance.

## Files That Matter

- `pack.ts`: `loadPack` / `writePack` (the inverse pair that makes re-onboarding
  idempotent) + subsystem markdown parse/serialize + cross-ref validation.
- `routing.ts`: `resolveContext` (additive routing) + the `globMatch` matcher.
- `provider.ts`: the `ContextProvider` implementation.
- `onboarding.ts`: the `OnboardingPipeline` orchestrator (inventory -> discover ->
  assess -> generate -> write, version bump, invariant confirmation).
- `inventory.ts`: deterministic, model-free repo inventory (languages, frameworks,
  CI, test command, modules).
- `discover.ts`: finds existing context (README, CLAUDE.md, the AGENTS.md hierarchy,
  docs/reviewer, docs/invariants, ADRs, and any normalized pack files).
- `assess.ts`: the ingest/augment/generate rubric per artifact.
- `fs-scan.ts`: the bounded, deterministic file walk (`walkFiles`) + `IGNORE_DIRS`
  + cheap excerpt reads. The single walk both discover and inventory use.

## Core Invariants

### Onboarding never walks into `data/` (or deps/build/VCS)

- `walkFiles` skips `IGNORE_DIRS`, which includes `data` alongside `node_modules`,
  `.git`, `dist`, etc. `data/` is the previewer's own runtime tree (SQLite +
  `data/workspaces/<owner>__<repo>/` checkouts); ingesting it would emit other
  repos' `AGENTS.md` as previewer subsystems and their top dirs as modules. That is
  exactly the pollution that stripped the subsystems from the first self-onboard.
  Both `discover` (nested-AGENTS subsystems) and `inventory` (modules) route through
  this one walk, so the exclusion belongs in `IGNORE_DIRS`, not at each call site.

### The security baseline is always resolved; the pack is never sent whole

- `resolveContext` seeds active profiles from `defaults.mandatoryProfiles` and
  always includes the security baseline, regardless of matched routes. Subsystems
  and invariants are filtered by changed paths. It returns a narrowed slice only.

### loadPack validates cross-references; writePack round-trips

- `loadPack` throws `ConfigError` when a route or mandatory profile references a
  profile not defined in `profiles.yaml`, or a required artifact is missing/invalid.
  `writePack` recomputes per-artifact sha256, removes stale subsystem files, and
  emits markdown that parses back through `loadPack` / `parseSubsystemGuide`.

### Generated invariants stay unconfirmed

- The pipeline forces generated invariants to `status: needs_confirmation` (never
  auto-enforced) and records per-artifact provenance. Re-onboarding bumps the pack
  version and preserves already-confirmed invariants.

## Review Focus

When reviewing changes here, check:

1. Does any new file walk bypass `walkFiles` / `IGNORE_DIRS` and risk descending
   into `data/`?
2. Could a routing/resolve change make the security baseline conditional, or inline
   the full pack (all subsystems/invariants) into `ResolvedContext`?
3. Does a `writePack` format change still parse back via `loadPack`?
4. Does onboarding ever set an invariant to `confirmed` without human approval?
5. Glob matcher edge cases in `routing.ts` (`**`, `**/`, `*`).

## Validation

- `npm test -- tests/routing.test.ts tests/onboarding.test.ts tests/onboard-discovery-data-exclusion.test.ts tests/fixtures.test.ts`
