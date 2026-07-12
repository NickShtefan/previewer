# Ingress Guide

This file applies to `src/apps/ingress/`.

## Scope

The webhook HTTP server: the only network-exposed surface. It verifies GitHub
webhooks, dedupes deliveries, filters events, and enqueues review jobs. It never
does review work on the HTTP path (ack-then-work): the request only verifies and
enqueues, then returns a 2xx. `handleWebhook` is pure of HTTP so it is fully
unit-testable.

## Files That Matter

- `server.ts`: `handleWebhook` + `handlePullRequest` + `handleIssueComment`. The
  routing and authorization logic.
- `main.ts`: the HTTP wiring (reads the raw body, headers, starts the listener,
  runs a catch-up sweep on start).

HMAC verification and payload extraction live in `src/github/webhook.ts`; ingress
consumes them (`WebhookVerifier`, `extractPullRequestEvent`,
`extractIssueCommentEvent`, `matchesReviewCommand`, `commentAuthorCanCommand`).

## Core Invariants

### Verify HMAC first, fail closed

- `handleWebhook` calls `verifier.verify(rawBody, signature)` before anything else
  and returns 401 on failure. An empty secret or missing signature must not pass.
  Verification runs against the raw body, before JSON parsing.

### Delivery idempotency

- A seen `X-GitHub-Delivery` short-circuits as `duplicate-delivery`; every handled
  outcome calls `markDelivery`. The one deliberate exception: a transient
  `getPullRequest` failure on a re-review returns 500 WITHOUT marking the delivery,
  so a manual redelivery can retry.

### Event filtering

- Only `pull_request` and `issue_comment` events are processed; PR actions are
  gated to `{opened, reopened, synchronize, ready_for_review}` and drafts per repo
  config. Unconfigured repos are ignored.

### /rereview is write-access-only and created-only

- A re-review command fires only on `action=created` comments on a PR from an
  OWNER/MEMBER/COLLABORATOR author. Edited comments and non-write authors are
  ignored silently (logged). The command enqueues a FORCED FULL re-review of the
  PR's current head (resolved via the GitHub client, since the comment payload
  carries no SHA).

## Review Focus

When reviewing changes here, check:

1. Is HMAC verification still the first step, before any parse or state read?
2. Does any change accept comment `edited` events or widen the author associations
   that can command a review?
3. Does the HTTP path do any review work before returning 2xx?
4. Are all handled outcomes marking the delivery (except the deliberate transient
   re-review 500)?

Auth/intake regressions here are high severity: this surface spends tokens and
posts to GitHub on unauthenticated input.

## Validation

- `npm test -- tests/ingress.test.ts tests/webhook-hmac.test.ts`
