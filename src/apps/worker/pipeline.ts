import { randomUUID } from "node:crypto";
import type {
  Store,
  GitHubClient,
  ContextProvider,
  Publisher,
  RunnerRegistry,
  RunContext,
  PrRef,
  PullRequestMeta,
} from "../../core";
import { reviewKey } from "../../core";
import type { ReviewInput, ReviewResult, ReviewRun, RepoConfig } from "../../config";
import type { Logger } from "../../telemetry";
import type { WorkspaceProvider, PreparedWorkspace } from "./workspace";
import type { DependencyInstaller } from "./install";
import { gate } from "./gate";
import { changeSignals, selectRunnerSelector } from "./policy";

export interface ReviewRequest {
  repo: string;
  prNumber: number;
  dryRun?: boolean;
  force?: boolean;
  /** Force a specific runner by id (CLI `--runner`), overriding repo.yaml policy selection. */
  runner?: string;
}

export interface PipelineDeps {
  store: Store;
  github: GitHubClient;
  workspace: WorkspaceProvider;
  context: ContextProvider;
  runners: RunnerRegistry;
  publisher: Publisher;
  repoConfig: RepoConfig;
  logger: Logger;
  language?: "ru" | "en";
  now?: () => Date;
  /** Optional: installs deps in the worktree when a repo opts into running tests. */
  installer?: DependencyInstaller;
}

export type PipelineOutcome =
  | { status: "reviewed"; result: ReviewResult; commentId?: number }
  | { status: "dry-run"; result: ReviewResult }
  | { status: "duplicate" }
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string; retriable: boolean };

/**
 * One review-run: PR meta → dedupe → workspace+diff → gate → resolve context →
 * select runner → review → publish (one comment) → record. Dry-run skips all
 * state side-effects (no claim, no publish, no record) so it can be re-run freely.
 */
export async function reviewPipeline(deps: PipelineDeps, req: ReviewRequest): Promise<PipelineOutcome> {
  const now = deps.now ?? (() => new Date());
  const ref: PrRef = { repo: req.repo, prNumber: req.prNumber };

  const pr = await deps.github.getPullRequest(ref);
  if (pr.state === "closed") return { status: "skipped", reason: "PR is closed" };
  if (pr.isDraft && deps.repoConfig.events.ignoreDraft) return { status: "skipped", reason: "PR is draft" };

  const key = reviewKey(req.repo, req.prNumber, pr.headSha);
  if (!req.dryRun) {
    if ((await deps.store.claimReview(key, { force: req.force })) === "duplicate") {
      return { status: "duplicate" };
    }
  }

  const last = deps.repoConfig.review.incremental
    ? await deps.store.lastReviewedSha(req.repo, req.prNumber)
    : null;
  const mode: "incremental" | "full" = last ? "incremental" : "full";
  const fromSha = last ?? pr.baseSha;

  const ws = await deps.workspace.prepare(req.repo, fromSha, pr.headSha, mode, pr.baseSha);
  const startedAt = now().toISOString();
  try {
    const decision = gate({
      changedFiles: ws.diff.changedFiles,
      ignorePaths: deps.repoConfig.events.ignorePaths,
    });
    if (decision.action === "skip") {
      if (!req.dryRun) {
        await deps.store.recordRun(skipRun(req, pr, startedAt, now().toISOString(), decision.reason));
      }
      return { status: "skipped", reason: decision.reason };
    }

    const resolved = await deps.context.resolve(req.repo, ws.diff.changedFiles);
    const signals = changeSignals(ws.diff.changedFiles, resolved);
    const runner = req.runner
      ? deps.runners.get(req.runner)
      : deps.runners.select(selectRunnerSelector(deps.repoConfig, signals));

    // Opt-in: only run tests when the repo enabled it AND an active profile asks for it.
    const runTests =
      deps.repoConfig.review.runTests && resolved.tests.length > 0 && resolved.profiles.some((p) => p.runTests);
    if (runTests && deps.installer) {
      const r = await deps.installer.install(ws.dir, { logger: deps.logger, signal: AbortSignal.timeout(600_000) });
      deps.logger.info(`deps: installed ${r.installedDirs.length}, reused/skipped ${r.skipped.length}, failed ${r.failed.length}`);
    }

    deps.logger.info(
      `reviewing ${req.repo}#${req.prNumber}@${pr.headSha.slice(0, 8)} via ${runner.id} ` +
        `[${resolved.activeProfiles.join(",")}]${runTests ? " +tests" : ""} ${ws.diff.changedFiles.length} files`,
    );

    const input = buildReviewInput(deps, pr, ws, resolved, runTests);
    const ctx: RunContext = {
      workspaceDir: ws.dir,
      budget: { maxInputTokens: deps.repoConfig.review.maxTokensPerRun, maxOutputTokens: 8000 },
      logger: deps.logger,
      signal: AbortSignal.timeout(600_000),
      cacheKey: `${req.repo}@${resolved.packVersion}:${resolved.activeProfiles.join(",")}`,
      runTests,
    };
    const result = await runner.review(input, ctx);

    if (req.dryRun) return { status: "dry-run", result };

    let commentId: number | undefined;
    if (result.status !== "error" && result.comment) {
      commentId = (await deps.publisher.upsertReviewComment(ref, pr.headSha, result.comment.bodyMarkdown))
        .commentId;
    }
    await deps.store.recordRun(toRun(req, pr, result, commentId, startedAt, now().toISOString()));

    if (result.status === "error") {
      return {
        status: "error",
        message: result.error?.message ?? "runner error",
        retriable: result.error?.retriable ?? true,
      };
    }
    return { status: "reviewed", result, commentId };
  } finally {
    await ws.cleanup();
  }
}

function buildReviewInput(
  deps: PipelineDeps,
  pr: PullRequestMeta,
  ws: PreparedWorkspace,
  resolved: ReviewInput["context"],
  allowTests: boolean,
): ReviewInput {
  const cfg = deps.repoConfig;
  return {
    repo: { id: cfg.repo.id, defaultBranch: cfg.repo.defaultBranch },
    pr: {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      author: pr.author,
      isDraft: pr.isDraft,
    },
    diff: ws.diff,
    context: resolved,
    output: {
      commentTemplate: resolved.commentTemplate,
      language: deps.language ?? "en",
      maxCommentChars: 65000,
    },
    budget: { maxInputTokens: cfg.review.maxTokensPerRun, maxOutputTokens: 8000, depthHint: "normal" },
    workspace: { dir: ws.dir, allowTests, readBudgetFiles: 40 },
  };
}

function toRun(
  req: ReviewRequest,
  pr: PullRequestMeta,
  result: ReviewResult,
  commentId: number | undefined,
  startedAt: string,
  finishedAt: string,
): ReviewRun {
  return {
    id: randomUUID(),
    repo: req.repo,
    prNumber: req.prNumber,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    runner: result.meta.runnerId,
    model: result.meta.model,
    profile: result.meta.profile,
    status: result.status,
    commentId,
    tokensIn: result.meta.tokensIn,
    tokensOut: result.meta.tokensOut,
    usd: result.meta.usd,
    durationMs: result.meta.durationMs,
    error: result.error?.message ?? null,
    startedAt,
    finishedAt,
  };
}

function skipRun(
  req: ReviewRequest,
  pr: PullRequestMeta,
  startedAt: string,
  finishedAt: string,
  reason: string,
): ReviewRun {
  return {
    id: randomUUID(),
    repo: req.repo,
    prNumber: req.prNumber,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    status: "skipped",
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    durationMs: 0,
    error: reason,
    startedAt,
    finishedAt,
  };
}
