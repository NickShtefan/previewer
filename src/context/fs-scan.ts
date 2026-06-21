import { readdirSync, readFileSync, existsSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";

function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Dirs never worth scanning during onboarding (deps, build output, VCS, caches). */
export const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage",
  "vendor", "target", "__pycache__", ".venv", "venv", ".turbo", ".cache", "tmp",
  ".idea", ".vscode", ".svelte-kit", ".parcel-cache", "bower_components", ".pytest_cache",
]);

/**
 * Bounded, deterministic recursive file list (repo-relative POSIX-ish paths).
 * Skips IGNORE_DIRS and dotdirs (except `.github`, which carries CI config).
 * Caps total files so onboarding a huge monorepo stays cheap.
 */
export function walkFiles(root: string, cap = 20000): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length && out.length < cap) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const e of safeReaddir(dir)) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        if (e.name.startsWith(".") && e.name !== ".github") continue;
        stack.push(full);
      } else if (e.isFile()) {
        out.push(relative(root, full).split("\\").join("/"));
        if (out.length >= cap) break;
      }
    }
  }
  return out.sort();
}

/** Read a file's first `max` chars, or "" if unreadable. Used for cheap excerpts. */
export function readExcerpt(root: string, rel: string, max = 1500): string {
  try {
    const full = join(root, rel);
    if (!existsSync(full)) return "";
    return readFileSync(full, "utf8").slice(0, max);
  } catch {
    return "";
  }
}

/** Read a whole file or return undefined (never throws). */
export function readMaybe(root: string, rel: string): string | undefined {
  try {
    const full = join(root, rel);
    if (!existsSync(full)) return undefined;
    return readFileSync(full, "utf8");
  } catch {
    return undefined;
  }
}
