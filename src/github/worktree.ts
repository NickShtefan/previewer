import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

/**
 * Non-destructive checkout of `sha` from a local repo via `git worktree` into a
 * temp dir — does NOT touch the user's working tree. Used by `--local` dry-runs.
 */
export async function addWorktree(repoDir: string, sha: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const parent = await mkdtemp(join(tmpdir(), "previewer-wt-"));
  const dir = join(parent, "wt");
  await exec("git", ["-C", repoDir, "worktree", "add", "--detach", dir, sha]);
  const cleanup = async (): Promise<void> => {
    try {
      await exec("git", ["-C", repoDir, "worktree", "remove", "--force", dir]);
    } catch {
      /* best effort */
    }
    await rm(parent, { recursive: true, force: true });
  };
  return { dir, cleanup };
}
