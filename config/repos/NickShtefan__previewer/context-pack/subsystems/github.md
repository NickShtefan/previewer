# Subsystem: github

**Path:** `src/github` · **Risk:** high

Everything that talks to GitHub, behind `core/GitHubClient` and `core/Publisher`: App/PAT auth, constant-time HMAC webhook verification, PR metadata reads, checkout + diff into a non-destructive worktree, and idempotent single-comment publishing.

## Files that matter

- `webhook.ts`: `GithubWebhookVerifier` (constant-time HMAC) + payload extraction + `/rereview` matching and author-association authorization.
- `publish.ts`: `SingleCommentPublisher` (find-by-marker then update-or-create).
- `git.ts` / `worktree.ts`: checkout, incremental/full diff, non-destructive worktrees. `app.ts`: App auth. `gateway.ts`: the `GitHubClient`. `manual.ts`: local `--local` path. `ports.ts`: narrow API ports.

## Invariants to enforce

- Webhook HMAC verification is constant-time and fails closed: false for empty secret/signature, length-check before `timingSafeEqual`, compares `sha256=<hmac>`. Never a plain string compare.
- Exactly one comment per head SHA via the hidden marker `<!-- ai-review:{repo}#{pr}@{head_sha} -->`: ensure the marker is in the body, find the prior comment carrying it and edit, else create. Never a blind post, never the formal-review API.
- Diff correctness feeds routing: incremental base selection, force-push handling, and the changed-file list must stay correct (routing and the gate consume that list).
- Least-privilege auth; API errors (rate limits, 404s) surface rather than becoming a false `reviewed` state.

## Review focus

Flag any change that replaces `timingSafeEqual` or makes the empty-secret case pass, a publish path that posts without searching for the marker or drops it or switches to formal reviews, a diff change that corrupts the changed-file list, or a swallowed GitHub error.

Validation: `npm test -- tests/webhook-hmac.test.ts tests/publish-idempotency.test.ts tests/git-diff.test.ts`.
