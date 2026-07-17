import { isLimitError } from "./limit-error";

/**
 * Retry classification for the review pipeline. A three-way split so the settle
 * path can tell a KNOWN-permanent signature apart from an unrecognised failure:
 *
 *   transient — an outage / throttle / connectivity blip that clears on its own:
 *               GitHub 5xx, 429, an HTML error page where JSON was expected
 *               (GitHub's "Unicorn!" page, proxy/Cloudflare interstitials), usage
 *               and rate limits, network resets, and request timeouts. Retried with
 *               back-off effectively forever, WITHOUT consuming the dead-letter
 *               budget, so a long GitHub/engine outage never loses a queued review.
 *   permanent — a KNOWN failure that will not succeed on retry: 4xx validation /
 *               not found and auth failures. Uses the normal `nack` attempts ->
 *               dead_letter path (fails fast on its own bounded budget).
 *   unknown   — an unrecognised fall-through. We can't prove it's permanent, so it
 *               gets a SMALL bounded retry (smaller than the permanent budget) and
 *               is journaled in detail on every occurrence, so novel signatures are
 *               captured and can later be promoted to transient/permanent above.
 *
 * Companion to `isLimitError` (usage/rate-limit signature, reused here) and the
 * dashboard's `classifyErrorKind` (display taxonomy); this axis drives the queue's
 * retry routing (see apps/worker/loop.ts and store/sqlite-queue.ts).
 */
export type FailureClass = "transient" | "permanent" | "unknown";

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

/**
 * Git transport failures during an outage. Workspace ops shell out to `git`, so the failure
 * arrives as a non-zero child-process exit (often 128) with these phrases in message/stderr —
 * NOT as an `err.status`/`err.code` the HTTP checks can see. This is the exact shape that
 * stranded jobs during a GitHub outage, so it must be treated as transient.
 *
 * Only UNAMBIGUOUS transport-layer signals belong here. Two generic phrases are deliberately
 * EXCLUDED because they front both transient and permanent failures, and a bare match would send
 * a permanent auth failure into the never-dead-letter transient path (infinite retry):
 *   - "unable to access '<url>'" — the specific cause after it (5xx/DNS/TLS) is what we match.
 *   - "could not read from remote repository" — also the standard suffix of `Permission denied
 *     (publickey)` / auth failures. Alone it is ambiguous, so it falls through to `unknown`
 *     (bounded retry + journal); a real auth failure carries `Permission denied (publickey)`,
 *     which AUTH_RE classifies permanent.
 * The HTTP-in-git line is likewise gated to retriable statuses (5xx/429/408), so a `403`/`404`
 * git failure falls through to auth (permanent) or `unknown` (bounded retry + journal), not transient.
 */
const GIT_TRANSPORT_RE =
  /(?:could not|couldn't) resolve host|temporary failure in name resolution|the remote end hung up|the requested url returned error: (?:5\d\d|429|408)|could not fetch \S+ from promisor remote|connection (?:timed out|reset)|reset by peer|failed to connect|early eof|rpc failed|ssl connect error|gnutls_handshake|network is unreachable/i;

/** A request timeout / abort. */
const TIMEOUT_RE = /timed?\s?out|timeout|\baborted\b|esockettimedout/i;

/** Auth / permission failure — will not clear on retry (a 403 *rate* limit is caught earlier). */
const AUTH_RE =
  /bad credentials|unauthorized|\b401\b|authentication failed|not accessible by integration|requires authentication|permission denied \(publickey\)|permission denied \(password\)/i;

/**
 * GitHub's transient 403s (the only 4xx that clears on retry): secondary/abuse rate limits and the
 * primary "API rate limit exceeded". Specific phrasing on purpose — a bare "429"/"quota" substring
 * must NOT flip a permission 403 to transient, hence this is checked only for status === 403.
 */
const RATE_LIMIT_403_RE = /secondary rate limit|abuse detection|api rate limit exceeded|exceeded a rate limit/i;

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

/** Child-process stderr (git shells out via execFile; the transport error text lands here). */
function extractStderr(err: unknown): string | undefined {
  const e = asRecord(err);
  const s = e?.stderr;
  return typeof s === "string" && s.length > 0 ? s : undefined;
}

/** Structured view of a thrown value for classification and detailed journaling. */
export interface FailureDetails {
  message: string;
  status?: number;
  code?: string;
  name: string;
  stack?: string;
  stderr?: string;
}

/** Extract the diagnostic fields of a thrown value (used for both routing and logging). */
export function describeFailure(err: unknown): FailureDetails {
  return {
    message: extractMessage(err),
    status: extractStatus(err),
    code: extractCode(err),
    name: err instanceof Error ? err.name : typeof err,
    stack: err instanceof Error ? err.stack : undefined,
    stderr: extractStderr(err),
  };
}

/** Classify a thrown value (or an error message string) for retry routing. */
export function classifyFailure(err: unknown): FailureClass {
  const { message, status, code, name, stderr } = describeFailure(err);
  // Git shells out; its transport error text can be in stderr rather than message.
  const text = stderr ? `${message}\n${stderr}` : message;

  // --- transient by AUTHORITATIVE signal (status/code/name) ---
  if (code !== undefined && NETWORK_CODES.has(code)) return "transient";
  if (name === "AbortError" || name === "TimeoutError") return "transient";
  if (status === 429) return "transient";
  if (status === 408) return "transient"; // Request Timeout — a transient 4xx (before the 4xx->permanent rule)
  if (status !== undefined && status >= 500 && status <= 599) return "transient";
  // GitHub's rate/abuse limits arrive as a 403 that DOES clear — the one transient 4xx. Recognise it
  // by its SPECIFIC text so a plain permission 403 (or a 403 whose URL merely contains "429") is not
  // swept in. Checked before the 4xx->permanent rule below.
  if (status === 403 && RATE_LIMIT_403_RE.test(text)) return "transient";

  // --- permanent by AUTHORITATIVE status: a 4xx/auth verdict wins BEFORE any text heuristic, so a
  //     401/404 whose URL / repo / PR number / SHA merely contains "429" or "quota" is not misread
  //     as an infinitely-retried limit error. ---
  if (status !== undefined && status >= 400 && status <= 499) return "permanent"; // 4xx (429 & 403-limit above)
  if (AUTH_RE.test(text)) return "permanent";

  // --- transient by TEXT heuristic — only for failures with NO authoritative HTTP status (runner
  //     strings, git stderr). Reaching here means status is undefined or a non-4xx/5xx (e.g. 3xx). ---
  if (isLimitError(text)) return "transient";
  if (TRANSIENT_TEXT_RE.test(text)) return "transient";
  if (GIT_TRANSPORT_RE.test(text)) return "transient"; // git clone/fetch outage failures
  if (HTML_JSON_RE.test(text)) return "transient";
  if (TIMEOUT_RE.test(text)) return "transient";

  // Unrecognised — can't prove it's permanent. Bounded retry + detailed journaling
  // (see apps/worker/loop.ts) so the novel signature can be triaged and promoted.
  return "unknown";
}
