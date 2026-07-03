import { describe, it, expect } from "vitest";
import { ReviewInput } from "../src/config";
import { ClaudeCliRunner, DefaultRunnerRegistry, buildReviewPrompt, extractJson } from "../src/runners";
import type { CliExecutor, CliResult } from "../src/runners";
import type { RunContext } from "../src/core";

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
    invariants: [
      {
        id: "no-eval",
        rule: "Never eval untrusted input",
        appliesTo: ["**"],
        status: "confirmed",
        severity: "high",
        reviewerQuestions: ["does this eval untrusted input?"],
      },
    ],
    tests: ["cd . && npm test -- x.test.ts"],
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

function fakeExecutor(out: { envelope?: unknown; stdout?: string; stderr?: string; exitCode?: number }): CliExecutor {
  return {
    async run(): Promise<CliResult> {
      if (out.envelope !== undefined) {
        return { stdout: JSON.stringify(out.envelope), stderr: "", exitCode: 0 };
      }
      return { stdout: out.stdout ?? "", stderr: out.stderr ?? "", exitCode: out.exitCode ?? 0 };
    },
  };
}

describe("buildReviewPrompt", () => {
  it("includes the diff, security baseline, active profile, invariant, and marker", () => {
    const p = buildReviewPrompt(input);
    expect(p).toContain("eval(userInput)");
    expect(p).toContain("data_leaks"); // default security baseline lens
    expect(p).toContain("security-baseline"); // active profile
    expect(p).toContain("no-eval"); // invariant id
    expect(p).toContain("<!-- ai-review:owner/repo#7@head456789 -->");
    expect(p).toContain("Output contract");
  });
});

describe("extractJson — tolerant", () => {
  it("parses bare, fenced, and prose-wrapped JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson("```json\n{\"a\":2}\n```")).toEqual({ a: 2 });
    expect(extractJson("Here you go:\n{\"a\":3}\nthanks")).toEqual({ a: 3 });
  });
  it("throws on garbage", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("ClaudeCliRunner", () => {
  it("maps a successful claude envelope into a ReviewResult", async () => {
    const envelope = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({
        status: "ok",
        comment: "## Review\nFound an eval of user input.\n<!-- ai-review:owner/repo#7@head456789 -->",
        findings: [
          { title: "eval of user input", severity: "high", file: "src/x.ts", line: 1, category: "security", detail: "RCE risk" },
        ],
        residualRisk: "did not run tests",
      }),
      model: "claude-opus-4-8",
      total_cost_usd: 0.0,
      duration_ms: 4200,
      usage: { input_tokens: 1200, output_tokens: 300 },
    };
    const runner = new ClaudeCliRunner({ executor: fakeExecutor({ envelope }) });
    const r = await runner.review(input, ctx);

    expect(r.status).toBe("ok");
    expect(r.reviewedHeadSha).toBe("head456789");
    expect(r.comment?.bodyMarkdown).toContain("Found an eval");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.severity).toBe("high");
    expect(r.comment?.severitySummary).toEqual({ high: 1 });
    expect(r.meta.tokensIn).toBe(1200);
    expect(r.meta.tokensOut).toBe(300);
    expect(r.meta.runnerId).toBe("claude-cli");
  });

  it("returns a retriable error result on non-zero exit", async () => {
    const runner = new ClaudeCliRunner({ executor: fakeExecutor({ exitCode: 1, stderr: "boom" }) });
    const r = await runner.review(input, ctx);
    expect(r.status).toBe("error");
    expect(r.error?.retriable).toBe(true);
  });

  it("returns a parse error when the model output has no JSON", async () => {
    const runner = new ClaudeCliRunner({
      executor: fakeExecutor({ envelope: { is_error: false, result: "I could not produce JSON", usage: {} } }),
    });
    const r = await runner.review(input, ctx);
    expect(r.status).toBe("error");
    expect(r.error?.kind).toBe("parse");
    expect(r.reviewedHeadSha).toBe("head456789");
  });
});

function recordingExecutor(
  envelope: unknown,
  calls: Array<{ command: string; args: string[]; input?: string }>,
): CliExecutor {
  return {
    async run(command, args, opts): Promise<CliResult> {
      calls.push({ command, args, input: opts?.input });
      return { stdout: JSON.stringify(envelope), stderr: "", exitCode: 0 };
    },
  };
}

describe("ClaudeCliRunner model + reasoning effort", () => {
  const okEnvelope = {
    is_error: false,
    result: JSON.stringify({
      status: "ok",
      comment: "ok\n<!-- ai-review:owner/repo#7@head456789 -->",
      findings: [],
      residualRisk: "n/a",
    }),
    usage: { input_tokens: 1, output_tokens: 1 },
    model: "m",
  };

  it("passes ctx.modelOverride as --model and reasoningEffort as --effort", async () => {
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const runner = new ClaudeCliRunner({ executor: recordingExecutor(okEnvelope, calls) });
    await runner.review(input, { ...ctx, modelOverride: "claude-opus-4-8", reasoningEffort: "high" });

    const args = calls[0]!.args;
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-8");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  it("passes claude's top effort levels (xhigh/max) through unclamped", async () => {
    for (const level of ["xhigh", "max"] as const) {
      const calls: Array<{ command: string; args: string[]; input?: string }> = [];
      const runner = new ClaudeCliRunner({ executor: recordingExecutor(okEnvelope, calls) });
      await runner.review(input, { ...ctx, reasoningEffort: level });
      expect(calls[0]!.args[calls[0]!.args.indexOf("--effort") + 1]).toBe(level);
    }
  });

  it("omits --model and --effort when neither is set", async () => {
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const runner = new ClaudeCliRunner({ executor: recordingExecutor(okEnvelope, calls) });
    await runner.review(input, { ...ctx });

    expect(calls[0]!.args).not.toContain("--model");
    expect(calls[0]!.args).not.toContain("--effort");
  });
});

describe("DefaultRunnerRegistry", () => {
  it("registers and selects by preferred id", () => {
    const reg = new DefaultRunnerRegistry();
    const runner = new ClaudeCliRunner({ executor: fakeExecutor({ envelope: {} }) });
    reg.register(runner);
    expect(reg.get("claude-cli")).toBe(runner);
    expect(reg.select({ policy: "fixed", preferred: "claude-cli" })).toBe(runner);
    expect(reg.all().map((c) => c.id)).toContain("claude-cli");
    expect(() => reg.get("nope")).toThrow();
  });
});
