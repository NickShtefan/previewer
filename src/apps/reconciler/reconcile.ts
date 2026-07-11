import type { GitHubClient, Store, Queue } from "../../core";
import type { RepoConfig } from "../../config";
import { makeJob } from "../../store";
import { drainQueue } from "../worker/loop";
import type { PipelineDeps } from "../worker/pipeline";

export interface UncoveredPr {
  repo: string;
  prNumber: number;
  headSha: string;
  title: string;
}

export interface ReconcileResult {
  repos: number;
  scanned: number;
  uncovered: UncoveredPr[];
  enqueued: number;
  processed: number;
}

/** Narrow deps — a full `Platform` satisfies this structurally. */
export interface ReconcileDeps {
  repoConfigs: RepoConfig[];
  github: Pick<GitHubClient, "listOpenPullRequests">;
  store: Pick<Store, "isReviewedOrInFlight">;
  queue: Queue;
  logger: { info(m: string): void; warn(m: string): void };
  pipelineDepsFor: (repo: string) => PipelineDeps;
}

export interface ReconcileOptions {
  /** Only report uncovered PRs; do not enqueue or review (0 model tokens). */
  dryRun?: boolean;
  /** Enqueue uncovered SHAs but do not drain (leave for a separate worker). */
  process?: boolean;
}

/**
 * Completeness sweep: list open non-draft PRs across enabled repos, find head SHAs
 * with no successful review, enqueue them, and (optionally) drain. The sweep itself
 * is metadata-only — it spends nothing on the model until an uncovered SHA is processed.
 */
export async function reconcile(deps: ReconcileDeps, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const uncovered: UncoveredPr[] = [];
  let scanned = 0;

  for (const cfg of deps.repoConfigs) {
    const repo = cfg.repo.id;
    let prs;
    try {
      prs = await deps.github.listOpenPullRequests(repo);
    } catch (e) {
      deps.logger.warn(`reconcile: listOpenPullRequests(${repo}) failed: ${(e as Error).message}`);
      continue;
    }
    for (const pr of prs) {
      if (pr.state === "closed") continue;
      if (pr.isDraft && cfg.events.ignoreDraft) continue;
      scanned++;
      // Skip heads already covered: terminally reviewed, a forced review in flight,
      // or a recent limit error still cooling down. Prevents duplicate codex spend.
      if (await deps.store.isReviewedOrInFlight(repo, pr.number, pr.headSha)) continue;
      uncovered.push({ repo, prNumber: pr.number, headSha: pr.headSha, title: pr.title });
    }
  }

  if (opts.dryRun) {
    return { repos: deps.repoConfigs.length, scanned, uncovered, enqueued: 0, processed: 0 };
  }

  let enqueued = 0;
  for (const u of uncovered) {
    const r = await deps.queue.enqueue(
      makeJob({ repo: u.repo, prNumber: u.prNumber, headSha: u.headSha, source: "reconciler" }),
    );
    if (r === "enqueued") enqueued++;
  }

  let processed = 0;
  if (opts.process !== false) {
    processed = await drainQueue(deps.queue, (repo) => deps.pipelineDepsFor(repo));
  }

  return { repos: deps.repoConfigs.length, scanned, uncovered, enqueued, processed };
}
