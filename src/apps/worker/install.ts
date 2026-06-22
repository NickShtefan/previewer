import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunLogger } from "../../core";
import { nodeExecutor, type CliExecutor } from "../../runners";

export interface InstallResult {
  installedDirs: string[];
  skipped: string[];
  failed: string[];
}

/** Installs a checkout's dependencies before the runner executes its tests. */
export interface DependencyInstaller {
  install(dir: string, ctx?: { logger?: RunLogger; signal?: AbortSignal }): Promise<InstallResult>;
}

/** Lockfile -> reproducible install command (frozen / from-lockfile). First match wins. */
const LOCK_CMD: Array<[string, string[]]> = [
  ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
  ["package-lock.json", ["npm", "ci"]],
  ["npm-shrinkwrap.json", ["npm", "ci"]],
];

/**
 * Best-effort Node dependency installer for the worktree. Monorepo-aware: installs in the root
 * and any first-level subdir that has a `package.json` + lockfile (e.g. `api/`, `web/`). Skips a
 * dir that already has `node_modules` (reuse) or no lockfile. Failures are reported, never thrown —
 * the runner will simply report the tests as not run. Each install is time-bounded.
 */
export class NodeDependencyInstaller implements DependencyInstaller {
  constructor(
    private readonly exec: CliExecutor = nodeExecutor,
    private readonly timeoutMs = 300_000,
  ) {}

  async install(root: string, ctx: { logger?: RunLogger; signal?: AbortSignal } = {}): Promise<InstallResult> {
    const res: InstallResult = { installedDirs: [], skipped: [], failed: [] };
    for (const dir of this.targetDirs(root)) {
      if (existsSync(join(dir, "node_modules"))) {
        res.skipped.push(dir);
        continue;
      }
      const cmd = this.cmdFor(dir);
      if (!cmd) {
        res.skipped.push(dir);
        continue;
      }
      try {
        const r = await this.exec.run(cmd[0]!, cmd.slice(1), { cwd: dir, timeoutMs: this.timeoutMs, signal: ctx.signal });
        if (r.exitCode === 0) res.installedDirs.push(dir);
        else {
          res.failed.push(dir);
          ctx.logger?.warn(`dependency install failed in ${dir} (exit ${r.exitCode})`);
        }
      } catch (e) {
        res.failed.push(dir);
        ctx.logger?.warn(`dependency install error in ${dir}: ${(e as Error).message}`);
      }
    }
    return res;
  }

  /** Root + first-level subdirs that carry an installable package (package.json + lockfile). */
  private targetDirs(root: string): string[] {
    const dirs: string[] = [];
    if (this.cmdFor(root)) dirs.push(root);
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      /* ignore */
    }
    for (const name of names) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const sub = join(root, name);
      if (this.cmdFor(sub)) dirs.push(sub);
    }
    return dirs;
  }

  private cmdFor(dir: string): string[] | null {
    if (!existsSync(join(dir, "package.json"))) return null;
    for (const [lock, cmd] of LOCK_CMD) if (existsSync(join(dir, lock))) return cmd;
    return null;
  }
}
