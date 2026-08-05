/**
 * Strip credentials from text before it is logged or persisted.
 *
 * The authenticated clone URL embeds the GitHub token
 * (`https://x-access-token:<token>@github.com/...`), and a failed `git clone`/`fetch`
 * surfaces that URL verbatim in the child-process error's `message` AND `stack`. Any
 * code that logs a raw error (see apps/worker/loop.ts journaling, ingress/reconciler
 * error lines) must run the text through this first so the token never reaches disk.
 */

/** URL userinfo password: `scheme://user:secret@host` -> `scheme://user:***@host`. */
const URL_CRED_RE = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^/\s@]+@/gi;

/** GitHub tokens by documented prefix: PAT (`github_pat_`) and `gh[oprsu]_` (OAuth/app/server/user/refresh). */
const GH_TOKEN_RE = /\b(gh[oprsu]_|github_pat_)[A-Za-z0-9_]+/g;

/** `Authorization: <scheme> <value>` (header or JSON) -> redact the value. */
const AUTH_HEADER_RE = /(authorization"?\s*[:=]\s*"?)(?:bearer\s+|token\s+|basic\s+)?[A-Za-z0-9._~+/=-]+/gi;

/** Redact GitHub tokens and URL/Authorization credentials from arbitrary text. Safe on empty input. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(URL_CRED_RE, "$1***@")
    .replace(GH_TOKEN_RE, "$1***")
    .replace(AUTH_HEADER_RE, "$1***");
}
