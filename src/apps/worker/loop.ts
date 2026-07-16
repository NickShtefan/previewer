import type { Queue, LeasedJob } from "../../core";
import { classifyFailure, describeFailure } from "../../core";
import type { Logger } from "../../telemetry";
import { reviewPipeline, type PipelineDeps, type PipelineOutcome, type ReviewRequest } from "./pipeline";

/** Default dead-letter budget for UNKNOWN (unclassified) failures — small, and < the permanent cap. */
const DEFAULT_UNKNOWN_MAX_ATTEMPTS = 3;

export interface DrainOptions {
  visibilityTimeoutMs?: number;
  retryDelayMs?: number;
  /** Dead-letter cap for UNKNOWN (unclassified) failures. Default 3 (smaller than the permanent budget). */
  unknownMaxAttempts?: number;
  /** Platform logger; used to journal unclassified failures in detail for investigation. */
  logger?: Pick<Logger, "warn">;
  /** Test seam: override the review function (defaults to the real pipeline). */
  runPipeline?: (deps: PipelineDeps, req: ReviewRequest) => Promise<PipelineOutcome>;
}

/**
 * Journal an unrecognised failure with the full picture (message, HTTP status, error
 * code, name, stack) under a greppable prefix, so novel signatures can be triaged and
 * later promoted into `classifyFailure`. Called once per occurrence.
 */
function journalUnclassified(logger: Pick<Logger, "warn"> | undefined, err: unknown): void {
  if (!logger) return;
  const d = describeFailure(err);
  logger.warn(
    `unclassified failure (bounded retry then dead_letter) — ` +
      `message=${JSON.stringify(d.message)} status=${d.status ?? "-"} code=${d.code ?? "-"} name=${d.name || "-"} ` +
      `stack: ${d.stack ?? "-"}`,
  );
}

/**
 * Settle a leased job after a failure by class:
 *   transient — `nackTransient`: back-off requeue that never dead-letters, so a long
 *               GitHub/engine outage never loses the review.
 *   permanent — `nack` on the queue's normal (larger) attempts -> dead_letter budget.
 *   unknown   — journal in detail, then `nack` on a SMALL bounded budget so a novel
 *               failure is retried a few times, captured for investigation, and given up.
 */
async function settleFailure(
  queue: Queue,
  leaseId: string,
  err: unknown,
  opts: DrainOptions,
): Promise<void> {
  const cls = classifyFailure(err);
  if (cls === "transient") {
    await queue.nackTransient(leaseId);
    return;
  }
  if (cls === "unknown") {
    journalUnclassified(opts.logger, err);
    await queue.nack(leaseId, opts.retryDelayMs ?? 60_000, {
      maxAttempts: opts.unknownMaxAttempts ?? DEFAULT_UNKNOWN_MAX_ATTEMPTS,
    });
    return;
  }
  // permanent — the normal bounded path.
  await queue.nack(leaseId, opts.retryDelayMs ?? 60_000);
}

/** Process one leased job: review, then ack (success) or requeue / dead-letter (failure). */
export async function processLeased(
  queue: Queue,
  leased: LeasedJob,
  deps: PipelineDeps,
  opts: DrainOptions = {},
): Promise<void> {
  const runPipeline = opts.runPipeline ?? reviewPipeline;
  let outcome: PipelineOutcome;
  try {
    // A human-requested full re-review (job.full) forces base..head AND bypasses the
    // completed-head claim dedupe, so re-reviewing an already-reviewed or reverted head runs.
    outcome = await runPipeline(deps, {
      repo: leased.repo,
      prNumber: leased.prNumber,
      full: leased.full,
      force: leased.full,
    });
  } catch (err) {
    // The pipeline THREW instead of returning an outcome — e.g. during a GitHub outage a
    // 5xx returns an HTML error page and JSON.parse blows up ("Unexpected token '<'").
    // Never let it escape: that would strand the job in 'running' for the whole lease and
    // abort the drain. Classify and requeue; a transient outage backs off indefinitely.
    await settleFailure(queue, leased.leaseId, err, opts);
    return;
  }
  if (outcome.status === "error" && outcome.retriable) {
    // A structured retriable error. If it reads as a transient outage/throttle, back off
    // without burning the dead-letter budget; permanent/unknown route as above.
    await settleFailure(queue, leased.leaseId, outcome.message, opts);
  } else {
    await queue.ack(leased.leaseId);
  }
}

/** Lease and process jobs until the queue is empty. Returns the count processed. */
export async function drainQueue(
  queue: Queue,
  makeDeps: (repo: string) => Promise<PipelineDeps> | PipelineDeps,
  opts: DrainOptions = {},
): Promise<number> {
  let processed = 0;
  for (;;) {
    const leased = await queue.lease(opts.visibilityTimeoutMs ?? 2_100_000);
    if (!leased) break;
    try {
      const deps = await makeDeps(leased.repo);
      await processLeased(queue, leased, deps, opts);
    } catch (err) {
      // Backstop: makeDeps failed, or an unexpected throw slipped past processLeased.
      // Settle the job so it is never stranded in 'running', and keep draining the rest
      // of the queue instead of aborting the whole loop on one bad job.
      await settleFailure(queue, leased.leaseId, err, opts);
    }
    processed++;
  }
  return processed;
}
