import type { Queue, LeasedJob } from "../../core";
import { reviewPipeline, type PipelineDeps } from "./pipeline";

export interface DrainOptions {
  visibilityTimeoutMs?: number;
  retryDelayMs?: number;
}

/** Process one leased job: review, then ack (or nack on a retriable error). */
export async function processLeased(
  queue: Queue,
  leased: LeasedJob,
  deps: PipelineDeps,
  opts: DrainOptions = {},
): Promise<void> {
  const outcome = await reviewPipeline(deps, { repo: leased.repo, prNumber: leased.prNumber });
  if (outcome.status === "error" && outcome.retriable) {
    await queue.nack(leased.leaseId, opts.retryDelayMs ?? 60_000);
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
    const deps = await makeDeps(leased.repo);
    await processLeased(queue, leased, deps, opts);
    processed++;
  }
  return processed;
}
