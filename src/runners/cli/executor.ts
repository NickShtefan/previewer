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
