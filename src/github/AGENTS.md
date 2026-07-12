# GitHub Gateway Guide

This file applies to `src/github/`.

## Scope

Everything that talks to GitHub, behind the `core/GitHubClient` and
`core/Publisher` seams: authentication (GitHub App installation tokens or a PAT),
constant-time HMAC webhook verification, PR metadata reads, checkout + diff into a
non-destructive git worktree, and idempotent single-comment publishing. The rest of
the platform sees only the interfaces; the octokit/git details stay here.

## Files That Matter

- `webhook.ts`: `GithubWebhookVerifier` (constant-time HMAC) + pure payload
  extraction + `/rereview` command matching and author-association authorization.
- `publish.ts`: `SingleCommentPublisher` (find-by-marker then update-or-create).
- `git.ts` / `worktree.ts`: checkout, incremental/full diff, non-destructive
  worktrees.
- `app.ts`: GitHub App / installation-token auth.
- `gateway.ts`: the `GitHubClient` implementation composing the above.
- `manual.ts`: local-checkout path for offline `--local` reviews.
- `ports.ts`: the narrow API ports (e.g. `IssueCommentsApi`) the publisher depends
  on.

## Core Invariants

### Webhook HMAC verification is constant-time and fails closed

- `verify()` returns false for an empty secret or signature, length-checks before
  `timingSafeEqual` (which throws on length mismatch), and compares
  `sha256=<hmac>`. Never a plain string compare.

### Exactly one comment per head SHA, located by a hidden marker

- The publisher computes the marker `<!-- ai-review:{repo}#{pr}@{head_sha} -->`,
  ensures it is in the body, lists existing comments, edits the one carrying the
  marker if present, else creates one. Never a blind post, never the formal-review
  API. This is what makes a crashed-then-retried worker edit rather than duplicate.

### Diff correctness feeds routing

- Incremental base selection, force-push handling, and the changed-file list must
  stay correct: the file list is what routing and the gate consume. A wrong diff
  silently changes which profiles and invariants apply.

### Auth is least-privilege and errors are not swallowed

- Prefer short-lived App installation tokens. API errors (rate limits, 404s) must
  surface, never be swallowed into a false `reviewed` state.

## Review Focus

When reviewing changes here, check:

1. Does any change replace `timingSafeEqual`, make the empty-secret case pass, or
   compare signatures as strings?
2. Does the publisher ever post without first searching for the marker, or drop the
   marker, or switch to formal reviews?
3. Can a diff/checkout change produce a wrong changed-file list?
4. Are GitHub API failures surfaced rather than turned into a fake success?

## Validation

- `npm test -- tests/webhook-hmac.test.ts tests/publish-idempotency.test.ts tests/git-diff.test.ts`
