import type { Runner, RunContext } from "../../core";
import type { ReviewInput, ReviewResult, RunnerCapabilities } from "../../config";
import { buildReviewPrompt } from "../shared/prompt";
import { parseEnvelope, buildReviewResult, describeCliFailure, errorResult, type Envelope } from "../shared/output";
import { nodeExecutor, sanitizedClaudeEnv, type CliExecutor } from "./executor";

export interface ClaudeCliOptions {
  executor?: CliExecutor;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  command?: string;
  /** Tools the reviewer may use. Read-only by default (no Bash/Edit) for a safe non-interactive run. */
  allowedTools?: string[];
  /** Strip inherited Claude Code session/auth env so `claude` auths fresh (subscription). Default true. */
  cleanEnv?: boolean;
  /** Retries when the model returns no parseable JSON envelope (output drift, esp. Fable). Default 3. */
  maxParseAttempts?: number;
}

const CAPABILITIES: RunnerCapabilities = {
  id: "claude-cli",
  kind: "cli",
  provider: "anthropic",
  agentic: true,
  needsWorkspace: true,
  canRunTests: true,
  structuredOutput: "via_prompt",
  contextWindow: 200000,
  cost: { inputPerMtok: 0, outputPerMtok: 0, fixedOverheadUsd: 0 }, // subscription, not per-token
  strengths: ["repo_exploration", "multi_file_reasoning", "test_execution", "subscription_billed"],
  weaknesses: ["output_drift", "subscription_rate_limits"],
  maxParallel: 1,
  auth: { type: "cli_session" },
};

/**
 * Default runner: `claude -p` (Claude Code, print mode) on the user's Claude
 * subscription — agentic, reads the checkout, can run narrow tests. No API key.
 */
export class ClaudeCliRunner implements Runner {
  readonly id = "claude-cli";
  readonly capabilities = CAPABILITIES;
  private readonly exec: CliExecutor;
  private readonly model?: string;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly command: string;
  private readonly allowedTools: string[];
  private readonly cleanEnv: boolean;
  private readonly maxParseAttempts: number;

  constructor(opts: ClaudeCliOptions = {}) {
    this.exec = opts.executor ?? nodeExecutor;
    this.model = opts.model;
    this.maxTurns = opts.maxTurns ?? 40;
    this.timeoutMs = opts.timeoutMs ?? 1_800_000;
    this.command = opts.command ?? "claude";
    this.allowedTools = opts.allowedTools ?? ["Read", "Grep", "Glob"];
    this.cleanEnv = opts.cleanEnv ?? true;
    this.maxParseAttempts = Math.max(1, opts.maxParseAttempts ?? 3);
  }

  async review(input: ReviewInput, ctx: RunContext): Promise<ReviewResult> {
    const prompt = buildReviewPrompt(input);
    // When the repo opted into test execution, grant Bash so the agent can run the resolved tests.
    const allowedTools = ctx.runTests ? [...this.allowedTools, "Bash"] : this.allowedTools;
    const args = [
      "-p",
      "--output-format",
      "json",
      "--max-turns",
      String(this.maxTurns),
      "--allowed-tools",
      allowedTools.join(","),
      // Load NO MCP servers. Without this, `claude -p` inherits the user's config
      // dir and auto-starts enabled channel plugins — notably the telegram plugin,
      // whose bun poller then "replaces" the live session's long-poll on the same
      // bot token (409) and drops the operator's Telegram MCP. `--strict-mcp-config`
      // (with no --mcp-config) keeps the subscription auth + core Read/Grep/Glob
      // tools but spawns no MCP/channel servers, so reviews never hijack Telegram.
      "--strict-mcp-config",
    ];
    const model = ctx.modelOverride ?? this.model;
    if (model) args.push("--model", model);
    if (ctx.reasoningEffort) args.push("--effort", ctx.reasoningEffort);

    // Claude models (esp. Fable) can drift off strict JSON, so a parse miss is a
    // transient output-format failure, not a real error. Retry the whole review a
    // couple times on drift; but a parsed error envelope (auth/limit) or a thrown
    // exec is NOT retried here (those don't fix themselves on a re-run).
    let lastDetail = "no output";
    for (let attempt = 1; attempt <= this.maxParseAttempts; attempt++) {
      let res;
      try {
        res = await this.exec.run(this.command, args, {
          cwd: ctx.workspaceDir,
          input: prompt,
          timeoutMs: this.timeoutMs,
          signal: ctx.signal,
          env: this.cleanEnv ? sanitizedClaudeEnv() : undefined,
        });
      } catch (e) {
        return errorResult(input, this.id, model ?? "claude", (e as Error).message);
      }
      // Prefer the JSON envelope even on a non-zero exit — it carries the real error (e.g. auth).
      let env: Envelope | undefined;
      try {
        env = parseEnvelope(res.stdout);
      } catch {
        env = undefined;
      }
      if (env) {
        if (env.isError) {
          const detail = env.resultText
            ? env.resultText.slice(0, 500)
            : `(empty result; subtype=${env.subtype || "?"}, turns=${env.numTurns})`;
          return errorResult(input, this.id, env.model, `claude error [${env.subtype || "?"}]: ${detail}`);
        }
        // The envelope parsed, but the model's FINAL message must itself be one strict
        // JSON findings object. Fable often returns prose/loose JSON here — that throws
        // in buildReviewResult, so treat it as drift and retry the whole review too.
        try {
          return buildReviewResult(input, this.id, env);
        } catch (e) {
          lastDetail = `envelope ok but review body not strict JSON: ${(e as Error).message}`;
          continue;
        }
      }
      // No parseable envelope: output drift. Retry unless out of attempts.
      lastDetail = describeCliFailure(res).detail;
    }
    return errorResult(
      input,
      this.id,
      model ?? "claude",
      `claude output drift (no JSON envelope) after ${this.maxParseAttempts} attempts: ${lastDetail}`,
    );
  }
}
