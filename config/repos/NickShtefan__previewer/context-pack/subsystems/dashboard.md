# Subsystem: dashboard

**Path:** `src/apps/dashboard` · **Risk:** medium

A read-only LAN status page (reviewing-now, recent reviews, recent errors, per-repo config, open-PR status). One self-contained HTML template with vanilla inline JS, served from read-only SQLite queries. It renders attacker-influenced data, so output escaping is the whole risk surface.

## Files that matter

- `html.ts`: the template literal + the client `esc()` helper + render functions.
- `queries.ts`: read-only SQLite queries. `system.ts`: host/process/config status. `error-kind.ts`: error classification. `main.ts`: HTTP wiring.

## Invariants to enforce

- Every dynamic value inserted into the DOM passes `esc()` (an entity escaper over `[&<>"']`): repo names, PR titles, models, error text, notes. No raw `innerHTML` concatenation of server data.
- Server strings embedded in the inline JS template literal must escape newlines/backticks/`${` (a raw newline in `errBody` once broke all dashboard JS, PR #13).
- Read-only: queries never write; the payload exposes no tokens/secrets; long error bodies collapse but stay escaped.

## Review focus

Flag any field concatenated into `innerHTML` without `esc()`, any multi-line or backtick-containing server string reaching the inline `<script>` unescaped, and any query that writes or surfaces a secret. An unescaped value here is an XSS on the operator's machine or a JS-breaking bug.

Validation: `npm test -- tests/dashboard.test.ts tests/dashboard-system.test.ts`.
