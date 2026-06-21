# Kourion — Repo Guide

**Product.** Multi-chain crypto portfolio tracker (EVM, Solana, Bitcoin, NEAR): portfolio value,
holdings, DeFi exposure, history, privacy-safe public share pages; anonymous by default. Tradeoff
priority: **financial correctness, privacy, and data provenance over convenience or cosmetic cleanup.**

**Repo map.**
- `api/` — Express + Prisma monolith; the system of record.
- `web/` — React + Vite frontend.
- `docs/` — architecture & product research (read before architecture-heavy changes, esp. `docs/metadata-layer.md`).
- `infra/` — deployment config.

**Architecture.** Express monolith with a strong internal boundary around reference data: scanners in
`api/src/sources/`, portfolio assembly in `api/src/services/portfolio.ts`, snapshots/recovery/reprice/
queues in `api/src/services/`, and reference data / prices / token-identity behind
`api/src/services/metadata/index.ts`. Treat the metadata layer as its own subsystem even though it is
in-process. Public sharing has a stricter privacy surface than owner views.

**Conventions.** Extend existing seams over parallel helpers; keep route handlers thin; preserve
comments that document invariants / prior incidents; do not refactor finance, snapshot, or privacy
code opportunistically.

**Nested guides:** `api/AGENTS.md`, `web/AGENTS.md`, and deeper — follow the most specific one for the
changed paths.
