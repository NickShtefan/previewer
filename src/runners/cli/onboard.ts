import type { PackGenerator, OnboardingGenerationRequest, PackGenerationResult, RunContext } from "../../core";
import { buildOnboardingPrompt } from "../shared/prompt";
import { parseEnvelope, parseOnboardingArtifacts, parseCodexEvents, type Envelope } from "../shared/output";
import { nodeExecutor, sanitizedClaudeEnv, sanitizedCodexEnv, type CliExecutor } from "./executor";

export interface ClaudeCliPackGeneratorOptions {
  executor?: CliExecutor;
  model?: string;
  /** Bounded — onboarding reads a whole repo; keep turns capped to control cost. */
  maxTurns?: number;
  timeoutMs?: number;
  command?: string;
  allowedTools?: string[];
  cleanEnv?: boolean;
}

/**
 * Onboarding generator on the Claude subscription: spawns `claude -p` inside the checkout
 * with read-only tools, parses the JSON envelope, and validates the model's pack artifacts.
 * Mirrors {@link ClaudeCliRunner}; injectable executor keeps it testable (tests pass canned output).
 */
export class ClaudeCliPackGenerator implements PackGenerator {
  private readonly exec: CliExecutor;
  private readonly model?: string;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly command: string;
  private readonly allowedTools: string[];
  private readonly cleanEnv: boolean;

  constructor(opts: ClaudeCliPackGeneratorOptions = {}) {
    this.exec = opts.executor ?? nodeExecutor;
    this.model = opts.model;
    this.maxTurns = opts.maxTurns ?? 30;
    this.timeoutMs = opts.timeoutMs ?? 900_000;
    this.command = opts.command ?? "claude";
    this.allowedTools = opts.allowedTools ?? ["Read", "Grep", "Glob"];
    this.cleanEnv = opts.cleanEnv ?? true;
  }

  async generate(req: OnboardingGenerationRequest, ctx: RunContext): Promise<PackGenerationResult> {
    const prompt = buildOnboardingPrompt(req);
    const args = [
      "-p",
      "--output-format",
      "json",
      "--max-turns",
      String(this.maxTurns),
      "--allowed-tools",
      this.allowedTools.join(","),
    ];
    if (this.model) args.push("--model", this.model);

    const res = await this.exec.run(this.command, args, {
      cwd: ctx.workspaceDir,
      input: prompt,
      timeoutMs: this.timeoutMs,
      signal: ctx.signal,
      env: this.cleanEnv ? sanitizedClaudeEnv() : undefined,
    });

    let env: Envelope | undefined;
    try {
      env = parseEnvelope(res.stdout);
    } catch {
      env = undefined;
    }
    if (!env) {
      const detail = (res.stderr || res.stdout || "no output").slice(0, 500);
      throw new Error(`claude onboarding exited ${res.exitCode}: ${detail}`);
    }
    if (env.isError) {
      const detail = env.resultText ? env.resultText.slice(0, 500) : `(empty; subtype=${env.subtype || "?"})`;
      throw new Error(`claude onboarding error [${env.subtype || "?"}]: ${detail}`);
    }

    const artifacts = parseOnboardingArtifacts(env.resultText);
    return {
      artifacts,
      model: env.model,
      cost: { tokens: env.tokensIn + env.tokensOut, usd: env.usd },
    };
  }
}

export interface CodexPackGeneratorOptions {
  executor?: CliExecutor;
  model?: string;
  timeoutMs?: number;
  command?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  cleanEnv?: boolean;
}

/**
 * Onboarding generator on the ChatGPT subscription via `codex exec --json`. Same onboarding
 * prompt + artifact schema as {@link ClaudeCliPackGenerator}; only the engine and the result
 * parsing differ (codex streams JSONL — final answer is the last `agent_message`).
 */
export class CodexPackGenerator implements PackGenerator {
  private readonly exec: CliExecutor;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly command: string;
  private readonly sandbox: string;
  private readonly cleanEnv: boolean;

  constructor(opts: CodexPackGeneratorOptions = {}) {
    this.exec = opts.executor ?? nodeExecutor;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 900_000;
    this.command = opts.command ?? "codex";
    this.sandbox = opts.sandbox ?? "read-only";
    this.cleanEnv = opts.cleanEnv ?? true;
  }

  async generate(req: OnboardingGenerationRequest, ctx: RunContext): Promise<PackGenerationResult> {
    const prompt = buildOnboardingPrompt(req);
    const args = ["exec", "--json", "--sandbox", this.sandbox, "--skip-git-repo-check", "--color", "never"];
    if (ctx.workspaceDir) args.push("-C", ctx.workspaceDir);
    if (this.model) args.push("-m", this.model);

    const res = await this.exec.run(this.command, args, {
      cwd: ctx.workspaceDir,
      input: prompt,
      timeoutMs: this.timeoutMs,
      signal: ctx.signal,
      env: this.cleanEnv ? sanitizedCodexEnv() : undefined,
    });

    const parsed = parseCodexEvents(res.stdout); // throws if no agent_message -> pipeline falls back
    const artifacts = parseOnboardingArtifacts(parsed.resultText);
    return {
      artifacts,
      model: this.model ?? "codex",
      cost: { tokens: parsed.tokensIn + parsed.tokensOut, usd: 0 },
    };
  }
}
