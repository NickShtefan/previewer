import { spawn } from "node:child_process";

export interface CliRunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Child env. When undefined the child inherits the parent's process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable command runner — real impl spawns a process; tests pass a fake. */
export interface CliExecutor {
  run(command: string, args: string[], opts?: CliRunOptions): Promise<CliResult>;
}

/**
 * Strip inherited Claude Code session + auth-override env vars so a spawned `claude -p`
 * authenticates as a fresh launch (subscription via Keychain) instead of inheriting a
 * parent agent's host-managed/proxied session — which a child cannot reuse (-> 401).
 */
export function sanitizedClaudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const stripExact = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDECODE"]);
  for (const key of Object.keys(env)) {
    // Keep CLAUDE_CODE_OAUTH_TOKEN — the legitimate headless subscription token (`claude setup-token`).
    if (key === "CLAUDE_CODE_OAUTH_TOKEN") continue;
    if (stripExact.has(key) || key.startsWith("CLAUDE_CODE_")) delete env[key];
  }
  return env;
}

/**
 * Force the `codex` CLI onto the ChatGPT subscription (its `~/.codex` login) by dropping
 * OpenAI API-key/base-url overrides from the child env — otherwise codex may silently bill
 * a paid API key. Mirrors {@link sanitizedClaudeEnv}'s subscription-first intent.
 */
export function sanitizedCodexEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT"]) delete env[key];
  return env;
}

export const nodeExecutor: CliExecutor = {
  run(command, args, opts = {}) {
    return new Promise<CliResult>((resolve, reject) => {
      const child = spawn(command, args, { cwd: opts.cwd, signal: opts.signal, env: opts.env });
      let stdout = "";
      let stderr = "";
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs) timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);

      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      });

      if (opts.input !== undefined) {
        child.stdin.write(opts.input);
        child.stdin.end();
      }
    });
  },
};
