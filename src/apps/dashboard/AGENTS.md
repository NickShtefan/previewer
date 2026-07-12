# Dashboard Guide

This file applies to `src/apps/dashboard/`.

## Scope

A read-only LAN status page: what is reviewing now, recently reviewed PRs, recent
errors, per-repo config, and open-PR status. It is a single self-contained HTML
template with vanilla inline JS, served from read-only queries against the SQLite
store. It renders attacker-influenced data (repo names, PR titles, raw runner error
bodies), so output escaping is the whole risk surface.

## Files That Matter

- `html.ts`: the one big template literal + the client `esc()` helper and the
  render functions. Every dynamic value must go through `esc()`.
- `queries.ts`: read-only SQLite queries for the status payloads.
- `system.ts`: host/process/config status assembly.
- `error-kind.ts`: classification of runner errors for display.
- `main.ts`: the HTTP server wiring.

## Core Invariants

### Every dynamic value is escaped into the DOM

- `esc()` (an HTML-entity escaper over `[&<>"']`) wraps every server value
  concatenated into `innerHTML`. No raw concatenation of repo names, PR titles,
  models, error text, or notes.

### Server strings embedded in the inline JS must be escaped for JS

- The UI is one template literal with an inline `<script>`. Any server-derived
  string interpolated into that script must escape newlines/backticks/`${`
  sequences. A raw newline in `errBody` once broke all dashboard JS (PR #13).

### The dashboard is read-only and leaks no secrets

- Queries stay read-only against the store; the status payload exposes no
  tokens/secrets. Long error bodies collapse but stay escaped.

## Review Focus

When reviewing changes here, check:

1. Is any new field inserted into `innerHTML` without `esc()`?
2. Could a multi-line or backtick-containing server string reach the inline script
   unescaped?
3. Does any new query write, or surface a secret/token in the payload?

An unescaped value here is an XSS on the operator's machine or a JS-breaking bug;
both are the primary severity concern for this subsystem.

## Validation

- `npm test -- tests/dashboard.test.ts tests/dashboard-system.test.ts`
