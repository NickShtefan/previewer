/**
 * Classify a runner error message as a usage/rate-limit failure.
 *
 * Neutral, dependency-free helper shared by the store (reconcile back-off) and,
 * later, the dashboard. Kept here in `core` so app layers can reuse it without
 * importing across app boundaries. Matching is intentionally broad: a limit hit
 * should never be retried immediately, so a false positive (a short cooldown) is
 * far cheaper than a false negative (burning more tokens into the same limit).
 */
const LIMIT_ERROR_RE = /usage limit|rate limit|too many requests|429|quota|try again at/i;

export function isLimitError(message: string | null | undefined): boolean {
  return message != null && LIMIT_ERROR_RE.test(message);
}
