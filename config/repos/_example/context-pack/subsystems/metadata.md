# Subsystem: metadata

**Path:** `api/src/services/metadata` · **Risk:** high

The only public seam for reference data (token metadata, prices, icons, token identity, address
validation). "Service-shaped but in-process" — treat as its own subsystem inside the monolith.

**Rules:** import capabilities from `api/src/services/metadata/index.ts`, not internal files; do not add
request-path callers of CMC/CoinGecko/Jupiter/icon sources; background jobs own token discovery, price
refresh, and icon ingestion; do not duplicate symbol maps, chain regexes, or token-identity logic
outside the seam.

**Invariants:** `metadata-seam`, `token-identity`.
