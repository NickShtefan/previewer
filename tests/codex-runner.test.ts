import { describe, it, expect } from "vitest";
import { ReviewInput, Routing, Profiles, Invariant } from "../src/config";
import { CodexCliRunner, CodexPackGenerator, parseCodexEvents } from "../src/runners";
import type { CliExecutor, CliResult } from "../src/runners";
import type { RunContext, OnboardingGenerationRequest } from "../src/core";

const input = ReviewInput.parse({
  repo: { id: "owner/repo", defaultBranch: "main" },
  pr: { number: 7, title: "Add danger", baseSha: "base123", headSha: "head456789", author: "alice" },
  diff: {
    mode: "full",
    fromSha: "base123",
    toSha: "head456789",
    patch: "diff --git a/src/x.ts b/src/x.ts\n+ const danger = eval(userInput)",
    changedFiles: [{ path: "src/x.ts", status: "modified", additions: 1, deletions: 0 }],
  },
  context: {
    packVersion: "context-pack@v1",
    securityBaseline: {},
    activeProfiles: ["security-baseline"],
    invariants: [],
    tests: [],
  },
  output: { commentTemplate: "## Review\n{findings}", language: "en" },
  budget: { maxInputTokens: 100000, maxOutputTokens: 4000 },
  workspace: { dir: "/tmp/repo" },
});

const ctx: RunContext = {
  budget: { maxInputTokens: 1, maxOutputTokens: 1 },
  logger: { info() {}, warn() {}, error() {} },
  signal: new AbortController().signal,
  workspaceDir: "/tmp/repo",
};

/** Build a `codex exec --json` JSONL stream with a final agent_message + usage. */
function codexStream(agentText: string | null, usage = { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 300, reasoning_output_tokens: 50 }): string {
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "i0", type: "reasoning", text: "thinking" } }),
  ];
  if (agentText !== null) {
    lines.push(JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: agentText } }));
  }
  lines.push(JSON.stringify({ type: "turn.completed", usage }));
  return lines.join("\n") + "\n";
}

function fakeExecutor(stdout: string, exitCode = 0): CliExecutor {
  return {
    async run(): Promise<CliResult> {
      return { stdout, stderr: "", exitCode };
    },
  };
}

const MARKER = "<!-- ai-review:owner/repo#7@head456789 -->";

describe("parseCodexEvents", () => {
  it("extracts the last agent_message and sums usage (input+cached, output+reasoning)", () => {
    const r = parseCodexEvents(codexStream("hello"));
    expect(r.resultText).toBe("hello");
    expect(r.tokensIn).toBe(1200);
    expect(r.tokensOut).toBe(350);
  });
  it("throws when no agent_message was produced", () => {
    expect(() => parseCodexEvents(codexStream(null))).toThrow();
  });
});

describe("CodexCliRunner", () => {
  it("maps a codex JSONL stream into a ReviewResult", async () => {
    const modelOutput = JSON.stringify({
      status: "ok",
      comment: `## Review\nFound an eval of user input.\n${MARKER}`,
      findings: [{ title: "eval of user input", severity: "high", file: "src/x.ts", line: 1, category: "security", detail: "RCE" }],
      residualRisk: "did not run tests",
    });
    const runner = new CodexCliRunner({ executor: fakeExecutor(codexStream(modelOutput)) });
    const r = await runner.review(input, ctx);

    expect(r.status).toBe("ok");
    expect(r.reviewedHeadSha).toBe("head456789");
    expect(r.comment?.bodyMarkdown).toContain("Found an eval");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.severity).toBe("high");
    expect(r.meta.runnerId).toBe("codex-cli");
    expect(r.meta.model).toBe("codex");
    expect(r.meta.tokensIn).toBe(1200);
    expect(r.meta.tokensOut).toBe(350);
  });

  it("returns an error result when codex produced no agent_message", async () => {
    const runner = new CodexCliRunner({ executor: fakeExecutor(codexStream(null)) });
    const r = await runner.review(input, ctx);
    expect(r.status).toBe("error");
    expect(r.reviewedHeadSha).toBe("head456789");
  });

  it("returns a parse error when the agent_message has no JSON", async () => {
    const runner = new CodexCliRunner({ executor: fakeExecutor(codexStream("I could not produce JSON")) });
    const r = await runner.review(input, ctx);
    expect(r.status).toBe("error");
    expect(r.error?.kind).toBe("parse");
  });
});

describe("CodexPackGenerator", () => {
  it("parses onboarding artifacts from a codex stream", async () => {
    const artifacts = JSON.stringify({
      routing: Routing.parse({
        defaults: { mandatoryProfiles: ["security-baseline"] },
        routes: [{ name: "api", paths: ["api/**"], activateProfiles: ["security-baseline"] }],
      }),
      profiles: Profiles.parse({ profiles: { "security-baseline": { depth: "normal" } } }),
      invariants: [Invariant.parse({ id: "no-eval", rule: "Never eval untrusted input", severity: "high" })],
    });
    const gen = new CodexPackGenerator({ executor: fakeExecutor(codexStream(artifacts)) });
    const req: OnboardingGenerationRequest = {
      repo: "owner/repo",
      language: "en",
      inventory: { languages: [], frameworks: [], packageManagers: [], ci: [], test: {}, entrypoints: [], modules: [] },
      discovered: [],
      targets: ["routing", "profiles", "invariants"],
    };
    const res = await gen.generate(req, ctx);

    expect(res.model).toBe("codex");
    expect(res.cost.tokens).toBe(1550);
    expect(res.artifacts.routing?.routes.map((r) => r.name)).toEqual(["api"]);
    expect(Object.keys(res.artifacts.profiles?.profiles ?? {})).toContain("security-baseline");
    expect(res.artifacts.invariants?.map((i) => i.id)).toEqual(["no-eval"]);
  });
});
