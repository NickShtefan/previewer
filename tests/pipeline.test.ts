import { describe, it, expect } from "vitest";
import { openDatabase, SqliteStore } from "../src/store";
import { DefaultRunnerRegistry } from "../src/runners";
import { reviewPipeline, type PipelineDeps } from "../src/apps/worker/pipeline";
import type { WorkspaceProvider, PreparedWorkspace } from "../src/apps/worker/workspace";
import { createLogger } from "../src/telemetry";
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
} from "../src/core";

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
  constructor(private readonly result: ReviewResult) {}
  async review(input: ReviewInput): Promise<ReviewResult> {
    this.calls++;
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
  constructor(private readonly changedFiles: ChangedFile[]) {}
  async prepare(_repo: string, fromSha: string, headSha: string, mode: "incremental" | "full"): Promise<PreparedWorkspace> {
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
  async getPack(): Promise<null> {
    return null;
  }
  async resolve(): Promise<ResolvedContext> {
    return RESOLVED;
  }
}

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
    context: new FakeContext(),
    runners,
    publisher,
    repoConfig: REPO_CFG,
    logger: createLogger("test", "error"),
    now: () => new Date("2026-06-21T00:00:00.000Z"),
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
});
