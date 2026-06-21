# Subsystem: api

**Path:** `api` · **Risk:** high

Express + Prisma monolith; the product's source of truth. Owns portfolios, wallets, snapshots,
transactions, sharing state, auth/session, token identity/metadata/pricing reads, and background jobs
(snapshots, discovery, prices, icons, Solana sync). If backend and frontend disagree, the backend
contract wins.

**Local map:** `src/routes/` (HTTP contracts) · `src/services/` (business logic, queues, snapshots,
reprice, cost basis) · `src/services/metadata/` (reference-data seam) · `src/sources/` (upstream
scanners) · `src/middleware/` (auth gates) · `prisma/` (schema + migrations).

**Invariants:** `metadata-seam`, `token-identity`, `snapshot-integrity`, `scanner-idempotency`,
`cost-basis-honest-failure`, `auth-tma-constraints`, `schema-migration`.
