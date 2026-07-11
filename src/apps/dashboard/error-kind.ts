/* Shared classification of a stored review error message. The SQLite store keeps only a
   single `error` TEXT column (no dedicated status), so both the status panel (queries.ts)
   and the system-health card (system.ts) derive meaning from the text with these signatures.

   Two kinds of "wait and retry" are distinguished so the dashboard can tell them apart:
     usage_limit - the subscription quota is exhausted; comes back after a reset window.
     rate_limit  - transient throughput limiting / server overload; retry sooner. */

export type ErrorKind = "usage_limit" | "rate_limit" | "error";

/** Subscription usage/quota exhaustion (a billing block that clears at a reset time). */
const USAGE_LIMIT_RE = /usage.?limit|quota|try again at|\bplan limit\b/i;

/** Transient throughput limiting or server overload. */
const RATE_LIMIT_RE = /rate.?limit|too many requests|\b429\b|overloaded|subscription_rate_limits/i;

/** Classify a stored error message. Usage-limit wins over rate-limit when both could match. */
export function classifyErrorKind(message: string): ErrorKind {
  if (USAGE_LIMIT_RE.test(message)) return "usage_limit";
  if (RATE_LIMIT_RE.test(message)) return "rate_limit";
  return "error";
}

/** Any quota/rate-limit signature. Drives system-health's `usageLimited` flag, which does not
    care which flavour of limit it was, only that the engine is blocked on a limit. */
export function isLimitError(message: string): boolean {
  return classifyErrorKind(message) !== "error";
}
