import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewInput, Routing, Profiles, Invariant } from "../src/config";
import { CodexCliRunner, CodexPackGenerator, parseCodexEvents } from "../src/runners";
import type { CliExecutor, CliResult } from "../src/runners";
import type { RunContext, OnboardingGenerationRequest } from "../src/core";
import { collectWorkspaceReviewContext } from "../src/runners/cli/workspace-context";

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

function failingExecutor(stdout: string, stderr: string, exitCode = 1): CliExecutor {
  return {
    async run(): Promise<CliResult> {
      return { stdout, stderr, exitCode };
    },
  };
}

function recordingExecutor(
  stdout: string,
  calls: Array<{ command: string; args: string[]; input?: string }>,
): CliExecutor {
  return {
    async run(command, args, opts): Promise<CliResult> {
      calls.push({ command, args, input: opts?.input });
      return { stdout, stderr: "", exitCode: 0 };
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

  it("captures the real error from stdout when stderr is only the stdin banner", async () => {
    // The regression: codex prints "Reading prompt from stdin..." to stderr, so a bare
    // `stderr || stdout` fallback hid the real usage-limit error that landed on stdout.
    const runner = new CodexCliRunner({
      executor: failingExecutor("You've hit your usage limit. Try again at 3:30 AM.", "Reading prompt from stdin...\n"),
    });
    const r = await runner.review(input, ctx);
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain("usage limit");
    expect(r.error?.message).not.toContain("Reading prompt from stdin");
  });

  it("keeps the tail of a long stderr so the real error survives", async () => {
    const filler = Array.from({ length: 400 }, (_, i) => `noise line ${i}`).join("\n");
    const stderr = `${filler}\nfatal: rate limit exceeded (429)`;
    const runner = new CodexCliRunner({ executor: failingExecutor("", stderr) });
    const r = await runner.review(input, ctx);
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain("fatal: rate limit exceeded (429)");
    expect(r.error?.message).not.toContain("noise line 0");
  });

  it("reports 'no output' when both streams are empty", async () => {
    const runner = new CodexCliRunner({ executor: failingExecutor("", "") });
    const r = await runner.review(input, ctx);
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain("no output");
  });

  it("preloads context as a starting point but allows agentic file reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "previewer-codex-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "AGENTS.md"), "Never eval untrusted input.\n");
    await writeFile(join(dir, "src", "x.ts"), 'import { safe } from "./safe";\nexport const value = safe();\n');
    await writeFile(join(dir, "src", "safe.ts"), "export const safe = () => 1;\n");
    await writeFile(join(dir, "src", "x.test.ts"), "// neighboring test\n");

    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const modelOutput = JSON.stringify({ status: "ok", comment: `No findings.\n${MARKER}`, findings: [], residualRisk: "tests not run" });
    const runner = new CodexCliRunner({ executor: recordingExecutor(codexStream(modelOutput), calls) });
    await runner.review(input, { ...ctx, workspaceDir: dir });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("--ephemeral");
    expect(calls[0]!.args).toContain("--ignore-user-config");
    expect(calls[0]!.args).toContain("--output-schema");
    expect(calls[0]!.input).toContain("Never eval untrusted input.");
    expect(calls[0]!.input).toContain("export const value = safe()");
    expect(calls[0]!.input).toContain("export const safe = () => 1");
    expect(calls[0]!.input).toContain("neighboring test");
    expect(calls[0]!.input).toContain("You may read and search repository files");
    expect(runner.capabilities.agentic).toBe(true);
    expect(runner.capabilities.structuredOutput).toBe("native_json");
  });

  it("passes ctx.modelOverride as -m and reasoningEffort as a config override", async () => {
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const modelOutput = JSON.stringify({ status: "ok", comment: `No findings.\n${MARKER}`, findings: [], residualRisk: "n/a" });
    const runner = new CodexCliRunner({ executor: recordingExecutor(codexStream(modelOutput), calls) });
    await runner.review(input, { ...ctx, modelOverride: "gpt-5-codex", reasoningEffort: "high" });

    const args = calls[0]!.args;
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5-codex");
    expect(args[args.indexOf("-c") + 1]).toBe("model_reasoning_effort=high");
  });

  it("maps xhigh to codex extra-high and passes max through unchanged", async () => {
    const cases: Array<["xhigh" | "max", string]> = [
      ["xhigh", "extra-high"],
      ["max", "max"],
    ];
    for (const [level, expected] of cases) {
      const calls: Array<{ command: string; args: string[]; input?: string }> = [];
      const modelOutput = JSON.stringify({ status: "ok", comment: `No findings.\n${MARKER}`, findings: [], residualRisk: "n/a" });
      const runner = new CodexCliRunner({ executor: recordingExecutor(codexStream(modelOutput), calls) });
      await runner.review(input, { ...ctx, reasoningEffort: level });
      expect(calls[0]!.args[calls[0]!.args.indexOf("-c") + 1]).toBe(`model_reasoning_effort=${expected}`);
    }
  });

  it("omits -m and reasoning override when neither is set", async () => {
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const modelOutput = JSON.stringify({ status: "ok", comment: `No findings.\n${MARKER}`, findings: [], residualRisk: "n/a" });
    const runner = new CodexCliRunner({ executor: recordingExecutor(codexStream(modelOutput), calls) });
    await runner.review(input, { ...ctx });

    expect(calls[0]!.args).not.toContain("-m");
    expect(calls[0]!.args.some((a) => a.startsWith("model_reasoning_effort="))).toBe(false);
  });
});

describe("collectWorkspaceReviewContext", () => {
  it("rejects traversal and symlinks that escape the checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "previewer-context-"));
    const outside = await mkdtemp(join(tmpdir(), "previewer-secret-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(outside, "secret.ts"), "TOP_SECRET\n");
    await writeFile(join(dir, "src", "entry.ts"), 'import "./leak";\n');
    await symlink(join(outside, "secret.ts"), join(dir, "src", "leak.ts"));

    const context = await collectWorkspaceReviewContext(dir, ["src/entry.ts", "../secret.ts"], 100_000);
    expect(context).toContain('import "./leak"');
    expect(context).not.toContain("TOP_SECRET");
    expect(context).not.toContain("../secret.ts");
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
