# Subsystem: web

**Path:** `web` · **Risk:** medium

React + Vite application UI (not a landing page). Reflects backend truth without recreating backend
business logic in the browser. Responsibilities: owner + public portfolio views, owner/public privacy
distinctions, Telegram Mini App + normal browser support, fast local UI state without a second source
of truth.

**Local map:** `src/api.ts` (shared API client — all network calls go through it) · `src/components/`
(product UI) · `src/components/auth/` · `src/components/share/` · `src/lib/` (TMA, analytics,
formatting, token search).

**Risk areas:** `PortfolioView` is a convergence point (owner/share rendering, cost-basis, coverage,
transactions, wallet management); share-conversion flows; auth UI / session continuity.

**Invariants:** `owner-public-divergence`, `public-share-privacy`, `auth-tma-constraints`,
`cost-basis-honest-failure`.
