import { isLimitError } from "./limit-error";

/**
 * Retry classification for the review pipeline: should a failure be retried
 * through an outage, or is it terminal?
 *
 *   transient — an outage / throttle / connectivity blip that clears on its own:
 *               GitHub 5xx, 429, an HTML error page where JSON was expected
 *               (GitHub's "Unicorn!" page, proxy/Cloudflare interstitials), usage
 *               and rate limits, network resets, and request timeouts. These must
 *               be retried with back-off effectively forever, WITHOUT consuming
 *               the dead-letter budget, so a long GitHub/engine outage never loses
 *               a queued review.
 *   permanent — a request that will not succeed on retry: 4xx validation / not
 *               found, auth failures, and programming bugs. These use the existing
 *               attempts -> dead_letter budget so they fail fast and surface.
 *
 * Companion to `isLimitError` (usage/rate-limit signature, reused here) and the
 * dashboard's `classifyErrorKind` (display taxonomy); this axis drives the queue's
 * retry routing (see apps/worker/loop.ts and store/sqlite-queue.ts#nackTransient).
 */
export type FailureClass = "transient" | "permanent";

/** Node/undici socket-level errors — always worth retrying. */
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ESOCKETTIMEDOUT",
]);

/** Transient infra phrasing not already covered by `isLimitError` (overload / 5xx text). */
const TRANSIENT_TEXT_RE =
  /overloaded|service unavailable|temporarily unavailable|bad gateway|gateway time-?out|abuse detection|try again later/i;

/** HTML (or otherwise non-JSON) where JSON was expected: an error page broke JSON.parse. */
const HTML_JSON_RE =
  /unexpected token '?<|invalid character '?<|is not valid json|unexpected end of json|<!doctype|<html|unicorn/i;

/** A request timeout / abort. */
const TIMEOUT_RE = /timed?\s?out|timeout|\baborted\b|esockettimedout/i;

/** Auth / permission failure — will not clear on retry (a 403 *rate* limit is caught earlier). */
const AUTH_RE =
  /bad credentials|unauthorized|\b401\b|authentication failed|not accessible by integration|requires authentication/i;

function asRecord(err: unknown): Record<string, unknown> | undefined {
  return typeof err === "object" && err !== null ? (err as Record<string, unknown>) : undefined;
}

/** Best-effort HTTP status from an Octokit RequestError / fetch-style error. */
function extractStatus(err: unknown): number | undefined {
  const e = asRecord(err);
  if (!e) return undefined;
  const resp = asRecord(e.response);
  for (const v of [e.status, e.statusCode, resp?.status]) {
    if (typeof v === "number") return v;
  }
  return undefined;
}

/** Best-effort error code (e.g. ECONNRESET) from the error or its `cause`. */
function extractCode(err: unknown): string | undefined {
  const e = asRecord(err);
  if (!e) return undefined;
  const cause = asRecord(e.cause);
  for (const v of [e.code, cause?.code]) {
    if (typeof v === "string") return v;
  }
  return undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const e = asRecord(err);
  if (e && typeof e.message === "string") return e.message;
  return String(err ?? "");
}

/** Classify a thrown value (or an error message string) for retry routing. */
export function classifyFailure(err: unknown): FailureClass {
  const message = extractMessage(err);
  const status = extractStatus(err);
  const code = extractCode(err);
  const name = err instanceof Error ? err.name : "";

  // --- transient: retry through an outage/throttle, never dead-letter ---
  if (code !== undefined && NETWORK_CODES.has(code)) return "transient";
  if (name === "AbortError" || name === "TimeoutError") return "transient";
  if (status === 429) return "transient";
  if (status !== undefined && status >= 500 && status <= 599) return "transient";
  // Usage/rate limits, incl. GitHub's 403 secondary rate limit (a 4xx that IS transient).
  if (isLimitError(message)) return "transient";
  if (TRANSIENT_TEXT_RE.test(message)) return "transient";
  if (HTML_JSON_RE.test(message)) return "transient";
  if (TIMEOUT_RE.test(message)) return "transient";

  // --- permanent: will not succeed on retry ---
  if (status !== undefined && status >= 400 && status <= 499) return "permanent"; // 4xx (429 handled above)
  if (AUTH_RE.test(message)) return "permanent";

  // Unknown / programming error -> permanent, so a real bug fails fast via the bounded
  // attempts -> dead_letter path instead of retrying forever.
  return "permanent";
}
