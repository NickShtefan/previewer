import type { Queue, LeasedJob } from "../../core";
import { classifyFailure } from "../../core";
import { reviewPipeline, type PipelineDeps, type PipelineOutcome, type ReviewRequest } from "./pipeline";

export interface DrainOptions {
  visibilityTimeoutMs?: number;
  retryDelayMs?: number;
  /** Test seam: override the review function (defaults to the real pipeline). */
  runPipeline?: (deps: PipelineDeps, req: ReviewRequest) => Promise<PipelineOutcome>;
}

/**
 * Settle a leased job after a failure. TRANSIENT (outage/throttle/network) -> a
 * back-off requeue that never dead-letters, so a long GitHub/engine outage never
 * loses the review. PERMANENT -> the bounded `nack` (attempts -> dead_letter) path.
 */
async function settleFailure(
  queue: Queue,
  leaseId: string,
  err: unknown,
  opts: DrainOptions,
): Promise<void> {
  if (classifyFailure(err) === "transient") {
    await queue.nackTransient(leaseId);
  } else {
    await queue.nack(leaseId, opts.retryDelayMs ?? 60_000);
  }
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
    // abort the drain. Classify and requeue; a transient outage backs off indefinitely
    // without ever dead-lettering.
    await settleFailure(queue, leased.leaseId, err, opts);
    return;
  }
  if (outcome.status === "error" && outcome.retriable) {
    // A structured retriable error. If it reads as a transient outage/throttle, back off
    // without burning the dead-letter budget; otherwise spend an `attempts` retry.
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
