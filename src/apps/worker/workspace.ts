import type { DiffResult } from "../../core";
import { gitDiff, ensureCheckout, ensureSha, addWorktree, mergeBaseSafe, commitExists, isAncestor } from "../../github";

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
    /** Base to fall back to when an incremental `fromSha` is missing or no longer in head's history. */
    fallbackSha?: string,
  ): Promise<PreparedWorkspace>;
}

/**
 * Guard the incremental diff against a force-push/rebase: if `fromSha` (the last reviewed SHA)
 * is gone or is no longer an ancestor of head, fall back to a full diff from `fallbackSha` (the
 * PR base). Best-effort `fetch` of `fromSha` first, since it may not be in the local checkout yet.
 */
async function effectiveFrom(
  dir: string,
  fromSha: string,
  headSha: string,
  mode: "incremental" | "full",
  fallbackSha?: string,
): Promise<{ fromSha: string; mode: "incremental" | "full" }> {
  if (mode !== "incremental" || !fallbackSha || fromSha === fallbackSha) return { fromSha, mode };
  try {
    await ensureSha(dir, fromSha);
  } catch {
    /* fromSha may have been force-pushed away — handled by the checks below */
  }
  const usable = (await commitExists(dir, fromSha)) && (await isAncestor(dir, fromSha, headSha));
  return usable ? { fromSha, mode } : { fromSha: fallbackSha, mode: "full" };
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

  async prepare(repo: string, fromSha: string, headSha: string, mode: "incremental" | "full", fallbackSha?: string): Promise<PreparedWorkspace> {
    const dir = this.cacheDir(repo);
    await ensureCheckout({ url: this.cloneUrl(repo), dir, sha: headSha });
    const eff = await effectiveFrom(dir, fromSha, headSha, mode, fallbackSha);
    const base = await mergeBaseSafe(dir, eff.fromSha, headSha); // clean PR diff (vs merge-base)
    const diff = await gitDiff(dir, base, headSha);
    return { dir, diff: toDiff(diff, eff.mode, base, headSha), cleanup: async () => {} };
  }
}

/** `--local` path: non-destructive `git worktree` from an existing local checkout. */
export class LocalWorktreeProvider implements WorkspaceProvider {
  constructor(private readonly localDir: string) {}

  async prepare(_repo: string, fromSha: string, headSha: string, mode: "incremental" | "full", fallbackSha?: string): Promise<PreparedWorkspace> {
    await ensureSha(this.localDir, headSha);
    const eff = await effectiveFrom(this.localDir, fromSha, headSha, mode, fallbackSha);
    const base = await mergeBaseSafe(this.localDir, eff.fromSha, headSha); // clean PR diff
    const wt = await addWorktree(this.localDir, headSha);
    const diff = await gitDiff(wt.dir, base, headSha);
    return { dir: wt.dir, diff: toDiff(diff, eff.mode, base, headSha), cleanup: wt.cleanup };
  }
}
