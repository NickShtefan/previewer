import { describe, it, expect } from "vitest";
import { openDatabase, SqliteStore } from "../src/store";
import { DefaultRunnerRegistry } from "../src/runners";
import { reviewPipeline, type PipelineDeps } from "../src/apps/worker/pipeline";
import type { WorkspaceProvider, PreparedWorkspace } from "../src/apps/worker/workspace";
import { createLogger, type Logger } from "../src/telemetry";
import { RepoConfig } from "../src/config";
import type {
  ChangedFile,
  ResolvedContext,
  ReviewInput,
  ReviewResult,
  RunnerCapabilities,
} from "../src/config";
import type {
  GitHubClient,
  PullRequestMeta,
  ContextProvider,
  Publisher,
  Runner,
  RunContext,
} from "../src/core";
import type { DependencyInstaller, InstallResult } from "../src/apps/worker/install";

const cf = (path: string): ChangedFile => ({ path, status: "modified", additions: 3, deletions: 1, sizeClass: "small" });

const prMeta = (over: Partial<PullRequestMeta> = {}): PullRequestMeta => ({
  number: 7,
  title: "t",
  body: "",
  baseSha: "base123",
  headSha: "head456789",
  author: "a",
  isDraft: false,
  state: "open",
  ...over,
});

const RESOLVED: ResolvedContext = {
  packVersion: "context-pack@v1",
  repoGuideExcerpt: "guide",
  subsystems: [],
  invariants: [],
  securityBaseline: { alwaysCheck: ["data_leaks"], severityFloor: "medium", extra: [] },
  commentTemplate: "## Review\n{findings}",
  activeProfiles: ["security-baseline"],
  profiles: [],
  tests: [],
  requiredDocs: [],
  riskMap: [],
};

const FAKE_CAPS: RunnerCapabilities = {
  id: "fake",
  kind: "cli",
  provider: "test",
  agentic: false,
  needsWorkspace: false,
  canRunTests: false,
  structuredOutput: "via_prompt",
  contextWindow: 1000,
  cost: { inputPerMtok: 0, outputPerMtok: 0, fixedOverheadUsd: 0 },
  strengths: [],
  weaknesses: [],
  maxParallel: 1,
  auth: { type: "cli_session" },
};

const okResult: ReviewResult = {
  status: "ok",
  reviewedHeadSha: "head456789",
  comment: { bodyMarkdown: "looks fine", severitySummary: {} },
  findings: [],
  meta: { runnerId: "fake", model: "fake", profile: "security-baseline", tokensIn: 10, tokensOut: 5, usd: 0, durationMs: 100 },
};
const errResult: ReviewResult = {
  status: "error",
  reviewedHeadSha: "head456789",
  findings: [],
  meta: { runnerId: "fake", model: "fake", profile: "", tokensIn: 0, tokensOut: 0, usd: 0, durationMs: 0 },
  error: { kind: "runner", message: "boom", retriable: true },
};

class FakeRunner implements Runner {
  readonly id = "fake";
  readonly capabilities = FAKE_CAPS;
  calls = 0;
  lastRunTests: boolean | undefined;
  constructor(private readonly result: ReviewResult) {}
  async review(input: ReviewInput, ctx: RunContext): Promise<ReviewResult> {
    this.calls++;
    this.lastRunTests = ctx.runTests;
    return { ...this.result, reviewedHeadSha: input.pr.headSha };
  }
}

class FakeRunner2 implements Runner {
  readonly id = "fake2";
  readonly capabilities = { ...FAKE_CAPS, id: "fake2" };
  calls = 0;
  async review(input: ReviewInput): Promise<ReviewResult> {
    this.calls++;
    return { ...okResult, reviewedHeadSha: input.pr.headSha, meta: { ...okResult.meta, runnerId: "fake2" } };
  }
}

class FakeGithub implements GitHubClient {
  constructor(private readonly pr: PullRequestMeta) {}
  async getPullRequest(): Promise<PullRequestMeta> {
    return this.pr;
  }
  async listOpenPullRequests(): Promise<PullRequestMeta[]> {
    return [];
  }
  async checkout(): Promise<{ dir: string }> {
    return { dir: "/tmp" };
  }
  async diff(): Promise<never> {
    throw new Error("unused");
  }
}

class FakeWorkspace implements WorkspaceProvider {
  cleanupCalls = 0;
  lastMode?: "incremental" | "full";
  lastFromSha?: string;
  constructor(private readonly changedFiles: ChangedFile[]) {}
  async prepare(_repo: string, fromSha: string, headSha: string, mode: "incremental" | "full"): Promise<PreparedWorkspace> {
    this.lastMode = mode;
    this.lastFromSha = fromSha;
    return {
      dir: "/tmp/ws",
      diff: { mode, fromSha, toSha: headSha, patch: "diff", changedFiles: this.changedFiles },
      cleanup: async () => {
        this.cleanupCalls++;
      },
    };
  }
}

class FakeContext implements ContextProvider {
  constructor(private readonly resolved: ResolvedContext = RESOLVED) {}
  async getPack(): Promise<null> {
    return null;
  }
  async resolve(): Promise<ResolvedContext> {
    return this.resolved;
  }
}

class FakeInstaller implements DependencyInstaller {
  calls: string[] = [];
  async install(dir: string): Promise<InstallResult> {
    this.calls.push(dir);
    return { installedDirs: [dir], skipped: [], failed: [] };
  }
}

/** A resolved context whose active profile asks to run tests. */
const RESOLVED_WITH_TESTS: ResolvedContext = {
  ...RESOLVED,
  profiles: [{ depth: "deep", focus: [], docs: [], tests: ["npm test"], runTests: true }],
  tests: ["npm test"],
};

class FakePublisher implements Publisher {
  calls: Array<{ headSha: string; body: string }> = [];
  async upsertReviewComment(_ref: { repo: string; prNumber: number }, headSha: string, body: string): Promise<{ commentId: number }> {
    this.calls.push({ headSha, body });
    return { commentId: 4242 };
  }
}

const REPO_CFG = RepoConfig.parse({
  repo: { id: "owner/repo" },
  runner: { default: "fake", overrides: [] },
  events: { ignorePaths: ["**/*.lock"] },
});

interface Wiring {
  runner?: Runner;
  github?: GitHubClient;
  workspace?: FakeWorkspace;
  publisher?: FakePublisher;
  installer?: DependencyInstaller;
  resolved?: ResolvedContext;
  repoConfig?: RepoConfig;
  logger?: Logger;
}

/** A logger that captures info-level lines so tests can assert on what was logged. */
function spyLogger(): { logger: Logger; infos: string[] } {
  const infos: string[] = [];
  const base = createLogger("test", "debug");
  return { logger: { ...base, info: (m: string) => infos.push(m) }, infos };
}

function makeDeps(w: Wiring = {}): { deps: PipelineDeps; runner: FakeRunner; ws: FakeWorkspace; publisher: FakePublisher; store: SqliteStore } {
  const store = new SqliteStore(openDatabase(":memory:"));
  const runner = (w.runner as FakeRunner) ?? new FakeRunner(okResult);
  const ws = w.workspace ?? new FakeWorkspace([cf("src/x.ts")]);
  const publisher = w.publisher ?? new FakePublisher();
  const runners = new DefaultRunnerRegistry();
  runners.register(runner);
  const deps: PipelineDeps = {
    store,
    github: w.github ?? new FakeGithub(prMeta()),
    workspace: ws,
    context: new FakeContext(w.resolved),
    runners,
    publisher,
    repoConfig: w.repoConfig ?? REPO_CFG,
    logger: w.logger ?? createLogger("test", "error"),
    now: () => new Date("2026-06-21T00:00:00.000Z"),
    installer: w.installer,
  };
  return { deps, runner, ws, publisher, store };
}

describe("reviewPipeline", () => {
  it("happy path: reviews, publishes one comment, records the run, cleans up", async () => {
    const { deps, ws, publisher, store } = makeDeps();
    const outcome = await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7 });

    expect(outcome.status).toBe("reviewed");
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]!.headSha).toBe("head456789");
    expect(await store.lastReviewedSha("owner/repo", 7)).toBe("head456789");
    expect(ws.cleanupCalls).toBe(1);
  });

  it("dedupes a head SHA already reviewed", async () => {
    const { deps, publisher } = makeDeps();
    const first = await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7 });
    const second = await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7 });
    expect(first.status).toBe("reviewed");
    expect(second.status).toBe("duplicate");
    expect(publisher.calls).toHaveLength(1); // second run did not publish
  });

  it("skips drafts before doing any work", async () => {
    const runner = new FakeRunner(okResult);
    const { deps, publisher } = makeDeps({ runner, github: new FakeGithub(prMeta({ isDraft: true })) });
    const outcome = await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7 });
    expect(outcome.status).toBe("skipped");
    expect(runner.calls).toBe(0);
    expect(publisher.calls).toHaveLength(0);
  });

  it("gates out ignored-only diffs without running the model, but still cleans up", async () => {
    const runner = new FakeRunner(okResult);
    const ws = new FakeWorkspace([cf("deps.lock")]);
    const { deps } = makeDeps({ runner, workspace: ws });
    const outcome = await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7 });
    expect(outcome.status).toBe("skipped");
    expect(runner.calls).toBe(0);
    expect(ws.cleanupCalls).toBe(1);
  });

  it("dry-run: no claim, no publish, no record (re-runnable)", async () => {
    const { deps, publisher, store } = makeDeps();
    const a = await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7, dryRun: true });
    const b = await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7, dryRun: true });
    expect(a.status).toBe("dry-run");
    expect(b.status).toBe("dry-run"); // not a duplicate — dry-run never claims
    expect(publisher.calls).toHaveLength(0);
    expect(await store.lastReviewedSha("owner/repo", 7)).toBeNull();
  });

  it("honors the req.runner override, bypassing policy selection", async () => {
    const { deps, runner } = makeDeps(); // policy default = "fake"
    const other = new FakeRunner2();
    deps.runners.register(other);
    const outcome = await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7, runner: "fake2" });
    expect(outcome.status).toBe("reviewed");
    expect(other.calls).toBe(1); // the override ran
    expect(runner.calls).toBe(0); // the policy default did not
  });

  it("installs deps and grants test execution when repo + profile opt in", async () => {
    const runner = new FakeRunner(okResult);
    const installer = new FakeInstaller();
    const { deps } = makeDeps({
      runner,
      installer,
      resolved: RESOLVED_WITH_TESTS,
      repoConfig: RepoConfig.parse({ repo: { id: "owner/repo" }, runner: { default: "fake" }, review: { runTests: true } }),
    });
    const outcome = await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7 });
    expect(outcome.status).toBe("reviewed");
    expect(installer.calls).toHaveLength(1); // deps installed in the worktree
    expect(runner.lastRunTests).toBe(true); // runner granted shell for tests
  });

  it("does not install or grant tests when the repo flag is off (default)", async () => {
    const runner = new FakeRunner(okResult);
    const installer = new FakeInstaller();
    // REPO_CFG leaves review.runTests at its default (false), even though the profile wants tests.
    const { deps } = makeDeps({ runner, installer, resolved: RESOLVED_WITH_TESTS });
    await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7 });
    expect(installer.calls).toHaveLength(0);
    expect(runner.lastRunTests).toBeFalsy();
  });

  it("runner error: records the run, returns retriable error, no publish", async () => {
    const runner = new FakeRunner(errResult);
    const { deps, publisher, store } = makeDeps({ runner });
    const outcome = await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7 });
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") expect(outcome.retriable).toBe(true);
    expect(publisher.calls).toHaveLength(0);
    // an error run is still recorded for audit (status finalized, so it counts as reviewed SHA)
    expect(await store.lastReviewedSha("owner/repo", 7)).toBe("head456789");
  });

  it("logs the resolved model and effort on the review-start line", async () => {
    const { logger, infos } = spyLogger();
    const { deps } = makeDeps({ logger });
    await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7, model: "opus", reasoningEffort: "max" });
    const line = infos.find((m) => m.startsWith("reviewing "));
    expect(line).toContain("via fake/opus effort=max");
  });

  it("omits model/effort from the log line when neither is resolved", async () => {
    const { logger, infos } = spyLogger();
    const { deps } = makeDeps({ logger });
    await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7 });
    const line = infos.find((m) => m.startsWith("reviewing "));
    expect(line).toContain("via fake [");
    expect(line).not.toContain("effort=");
  });

  it("req.full forces a full base..head review, bypassing the incremental last-SHA", async () => {
    const ws = new FakeWorkspace([cf("src/x.ts")]);
    const { deps, store } = makeDeps({ workspace: ws });

    // Seed a prior reviewed head so incremental has a real from-point (a distinct earlier SHA).
    await store.recordRun({
      id: "seed",
      repo: "owner/repo",
      prNumber: 7,
      headSha: "prevhead0",
      status: "ok",
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      durationMs: 0,
      error: null,
      startedAt: "2026-06-20T00:00:00.000Z",
      finishedAt: "2026-06-20T00:00:00.000Z",
    });

    // Default (incremental on, req.full unset): diff from the last reviewed head.
    expect((await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7 })).status).toBe("reviewed");
    expect(ws.lastMode).toBe("incremental");
    expect(ws.lastFromSha).toBe("prevhead0");

    // req.full bypasses incremental -> full base..head, even with a prior reviewed SHA present.
    // (force lets it re-claim the head it just reviewed; this is exactly the /rereview path.)
    expect(
      (await reviewPipeline(deps, { repo: "owner/repo", prNumber: 7, full: true, force: true })).status,
    ).toBe("reviewed");
    expect(ws.lastMode).toBe("full");
    expect(ws.lastFromSha).toBe("base123");
  });
});
