# Subsystem: ingress

**Path:** `src/apps/ingress` · **Risk:** high

The webhook HTTP server: the only network-exposed surface. Verifies webhooks, dedupes deliveries, filters events, and enqueues review jobs. Ack-then-work: the HTTP path only verifies and enqueues, then returns a 2xx.

## Files that matter

- `server.ts`: `handleWebhook` + `handlePullRequest` + `handleIssueComment` (routing + authorization, pure of HTTP).
- `main.ts`: HTTP wiring (raw body, headers, catch-up sweep on start).

HMAC verify and payload extraction live in `src/github/webhook.ts`.

## Invariants to enforce

- Verify HMAC first and fail closed: `verifier.verify(rawBody, signature)` before any parse or state read; 401 on failure; empty secret/signature must not pass. Critical.
- Delivery idempotency: a seen `X-GitHub-Delivery` short-circuits; every handled outcome calls `markDelivery`. The one exception: a transient `getPullRequest` failure on re-review returns 500 WITHOUT marking, so a redelivery can retry.
- Event filtering: only `pull_request` and `issue_comment`; PR actions gated to `{opened, reopened, synchronize, ready_for_review}` and drafts per config; unconfigured repos ignored.
- `/rereview` fires only on `action=created` comments from OWNER/MEMBER/COLLABORATOR; edited comments and non-write authors are ignored silently. It enqueues a forced full re-review of the resolved current head.

## Review focus

Flag any change that moves verification after parsing, makes the empty-secret case pass, accepts comment `edited` events, widens the authorized associations, or does review work before the 2xx. Intake regressions are high severity: this surface spends tokens and posts to GitHub on unauthenticated input.

Validation: `npm test -- tests/ingress.test.ts tests/webhook-hmac.test.ts`.
