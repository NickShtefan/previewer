import type { DiffResult } from "../../core";
import { gitDiff, ensureCheckout, ensureSha, addWorktree } from "../../github";

export interface PreparedWorkspace {
  dir: string;
  diff: DiffResult;
  cleanup: () => Promise<void>;
}

/** Provides a checkout at the head SHA + the diff, abstracting clone vs local-worktree. */
export interface WorkspaceProvider {
  prepare(
    repo: string,
    fromSha: string,
    headSha: string,
    mode: "incremental" | "full",
  ): Promise<PreparedWorkspace>;
}

function toDiff(
  d: { patch: string; changedFiles: DiffResult["changedFiles"] },
  mode: "incremental" | "full",
  fromSha: string,
  toSha: string,
): DiffResult {
  return { mode, fromSha, toSha, patch: d.patch, changedFiles: d.changedFiles };
}

/** Normal path: clone into a per-repo cache dir and check out the head SHA. */
export class CacheWorkspaceProvider implements WorkspaceProvider {
  constructor(
    private readonly cloneUrl: (repo: string) => string,
    private readonly cacheDir: (repo: string) => string,
  ) {}

  async prepare(repo: string, fromSha: string, headSha: string, mode: "incremental" | "full"): Promise<PreparedWorkspace> {
    const dir = this.cacheDir(repo);
    await ensureCheckout({ url: this.cloneUrl(repo), dir, sha: headSha });
    if (mode === "incremental") await ensureSha(dir, fromSha);
    const diff = await gitDiff(dir, fromSha, headSha);
    return { dir, diff: toDiff(diff, mode, fromSha, headSha), cleanup: async () => {} };
  }
}

/** `--local` path: non-destructive `git worktree` from an existing local checkout. */
export class LocalWorktreeProvider implements WorkspaceProvider {
  constructor(private readonly localDir: string) {}

  async prepare(_repo: string, fromSha: string, headSha: string, mode: "incremental" | "full"): Promise<PreparedWorkspace> {
    await ensureSha(this.localDir, headSha);
    if (mode === "incremental") await ensureSha(this.localDir, fromSha);
    const wt = await addWorktree(this.localDir, headSha);
    const diff = await gitDiff(wt.dir, fromSha, headSha);
    return { dir: wt.dir, diff: toDiff(diff, mode, fromSha, headSha), cleanup: wt.cleanup };
  }
}
