import type { Runner, RunContext } from "../../core";
import type { ReviewInput, ReviewResult, RunnerCapabilities } from "../../config";
import { buildReviewPrompt } from "../shared/prompt";
import { buildReviewResult, errorResult, parseCodexEvents, type Envelope } from "../shared/output";
import { nodeExecutor, sanitizedCodexEnv, type CliExecutor } from "./executor";

export interface CodexCliOptions {
  executor?: CliExecutor;
  model?: string;
  timeoutMs?: number;
  command?: string;
  /** Codex sandbox policy. Review is read-only (no edits/network), like Claude's Read/Grep/Glob. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Strip OPENAI_* so codex uses the ChatGPT subscription, not a paid API key. Default true. */
  cleanEnv?: boolean;
}

const CAPABILITIES: RunnerCapabilities = {
  id: "codex-cli",
  kind: "cli",
  provider: "openai",
  agentic: true,
  needsWorkspace: true,
  canRunTests: true,
  structuredOutput: "via_prompt",
  contextWindow: 272000,
  cost: { inputPerMtok: 0, outputPerMtok: 0, fixedOverheadUsd: 0 }, // subscription, not per-token
  strengths: ["repo_exploration", "multi_file_reasoning", "subscription_billed"],
  weaknesses: ["output_drift", "subscription_rate_limits"],
  maxParallel: 1,
  auth: { type: "cli_session" },
};

/**
 * Alternative agentic runner: `codex exec --json` (OpenAI Codex CLI) on the user's ChatGPT
 * subscription. Same review prompt + output contract as {@link ClaudeCliRunner} — only the
 * engine and the result parsing differ (codex streams JSONL events; the final answer is the
 * last `agent_message`). Injectable executor keeps it offline-testable.
 */
export class CodexCliRunner implements Runner {
  readonly id = "codex-cli";
  readonly capabilities = CAPABILITIES;
  private readonly exec: CliExecutor;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly command: string;
  private readonly sandbox: string;
  private readonly cleanEnv: boolean;

  constructor(opts: CodexCliOptions = {}) {
    this.exec = opts.executor ?? nodeExecutor;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 600_000;
    this.command = opts.command ?? "codex";
    this.sandbox = opts.sandbox ?? "read-only";
    this.cleanEnv = opts.cleanEnv ?? true;
  }

  async review(input: ReviewInput, ctx: RunContext): Promise<ReviewResult> {
    const prompt = buildReviewPrompt(input);
    const args = ["exec", "--json", "--sandbox", this.sandbox, "--skip-git-repo-check", "--color", "never"];
    if (ctx.workspaceDir) args.push("-C", ctx.workspaceDir);
    if (this.model) args.push("-m", this.model);

    const startedAt = Date.now();
    try {
      const res = await this.exec.run(this.command, args, {
        cwd: ctx.workspaceDir,
        input: prompt,
        timeoutMs: this.timeoutMs,
        signal: ctx.signal,
        env: this.cleanEnv ? sanitizedCodexEnv() : undefined,
      });

      let parsed;
      try {
        parsed = parseCodexEvents(res.stdout);
      } catch {
        const detail = (res.stderr || res.stdout || "no output").slice(0, 500);
        return errorResult(input, this.id, this.model ?? "codex", `codex exited ${res.exitCode}: ${detail}`);
      }

      // Reuse the shared model-output mapping by adapting codex's stream to the Envelope shape.
      const env: Envelope = {
        isError: false,
        subtype: "",
        resultText: parsed.resultText,
        model: this.model ?? "codex",
        tokensIn: parsed.tokensIn,
        tokensOut: parsed.tokensOut,
        usd: 0,
        durationMs: Date.now() - startedAt,
        numTurns: 0,
      };
      return buildReviewResult(input, this.id, env);
    } catch (e) {
      return errorResult(input, this.id, this.model ?? "codex", (e as Error).message);
    }
  }
}
