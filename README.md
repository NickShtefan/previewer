# previewer

Autonomous, context-aware, **multi-repo AI PR review orchestrator**.

Event-driven: a GitHub PR event (or a reconciler sweep) enqueues a job, a worker resolves
per-repo context, runs a pluggable AI reviewer, and publishes exactly **one top-level comment
per head SHA** — never a formal review. Security/privacy/risk lens is a mandatory baseline.

- Architecture & design rationale → [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- MVP build plan, milestone by milestone → [`docs/MILESTONES.md`](docs/MILESTONES.md)

## Status

`M0 — Skeleton & Contracts`. Folder structure, all data formats as zod schemas, and the core
interfaces exist and type-check. Behavior is stubbed per milestone (`NotImplementedError`
messages name the milestone that fills them).

## Layout

```
src/
  config/   zod schemas for every format + loader   (the contract layer — source of truth)
  core/     behavioral interfaces (Store, Queue, Runner, Publisher, ContextProvider, ...)
  store/    SQLite Store + Queue                     (M1)
  github/   App auth, webhook verify, checkout/diff, idempotent publish   (M2)
  context/  context pack provider + onboarding       (M3 / M8)
  runners/  Runner registry + backends (API/CLI)     (M4)
  apps/     ingress | worker | reconciler | cli       (entrypoints)
config/
  platform.example.yaml     global config
  repos/<owner>__<name>/     per-repo config + context pack
```

## Scripts

```bash
npm install
npm run typecheck      # tsc --noEmit
npm test               # vitest
npm run cli -- help    # admin CLI surface
```
