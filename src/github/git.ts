import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ChangedFile } from "../config";

const exec = promisify(execFile);

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", dir, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export function sizeClassOf(changed: number): ChangedFile["sizeClass"] {
  if (changed <= 5) return "tiny";
  if (changed <= 50) return "small";
  if (changed <= 250) return "medium";
  if (changed <= 1000) return "large";
  return "huge";
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", rb: "ruby", php: "php",
  c: "c", h: "c", cpp: "cpp", cs: "csharp", swift: "swift", sql: "sql", sh: "shell",
  md: "markdown", yml: "yaml", yaml: "yaml", json: "json", toml: "toml", css: "css", html: "html",
};
export function languageOf(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? EXT_LANG[ext] : undefined;
}

const STATUS_MAP: Record<string, ChangedFile["status"]> = {
  A: "added", M: "modified", D: "removed", R: "renamed", C: "added", T: "modified",
};

export interface GitDiff {
  patch: string;
  changedFiles: ChangedFile[];
}

/**
 * Diff `fromSha..toSha` in a local checkout. Both commits must exist locally.
 * Note: rename path parsing (`old => new` in numstat) is approximate for now.
 */
export async function gitDiff(dir: string, fromSha: string, toSha: string): Promise<GitDiff> {
  const range = `${fromSha}..${toSha}`;
  const [patch, numstat, nameStatus] = await Promise.all([
    git(dir, ["diff", "--no-color", range]),
    git(dir, ["diff", "--numstat", range]),
    git(dir, ["diff", "--name-status", range]),
  ]);

  const statusByPath = new Map<string, ChangedFile["status"]>();
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0]?.[0] ?? "M";
    const path = parts[parts.length - 1] ?? "";
    statusByPath.set(path, STATUS_MAP[code] ?? "modified");
  }

  const changedFiles: ChangedFile[] = [];
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const addsRaw = cols[0] ?? "0";
    const delsRaw = cols[1] ?? "0";
    const path = cols.slice(2).join("\t");
    if (!path) continue;
    const additions = addsRaw === "-" ? 0 : Number(addsRaw); // "-" == binary
    const deletions = delsRaw === "-" ? 0 : Number(delsRaw);
    changedFiles.push({
      path,
      status: statusByPath.get(path) ?? "modified",
      additions,
      deletions,
      language: languageOf(path),
      sizeClass: sizeClassOf(additions + deletions),
    });
  }
  return { patch, changedFiles };
}

export interface EnsureCheckoutInput {
  url: string;
  dir: string;
  sha: string;
}

/** Ensure a local checkout of `repo` exists and `sha` (and its history) is present. Network. */
export async function ensureCheckout(input: EnsureCheckoutInput): Promise<{ dir: string }> {
  const { url, dir, sha } = input;
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    await exec("git", ["clone", "--no-checkout", "--filter=blob:none", url, dir]);
  }
  try {
    await git(dir, ["fetch", "--quiet", "origin", sha]);
  } catch {
    await git(dir, ["fetch", "--quiet", "origin"]);
  }
  await git(dir, ["checkout", "--force", "--detach", sha]);
  return { dir };
}

/**
 * Ensure a checkout of the repo's default branch exists at `dir` (for onboarding, which has
 * no specific SHA). Clones blobless on first use, otherwise fast-forwards to origin/HEAD.
 */
export async function ensureDefaultCheckout(url: string, dir: string): Promise<{ dir: string; sha: string }> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    await exec("git", ["clone", "--filter=blob:none", url, dir]);
  } else {
    await git(dir, ["fetch", "--quiet", "origin"]);
    const head = (await git(dir, ["rev-parse", "--abbrev-ref", "origin/HEAD"])).trim() || "origin/HEAD";
    await git(dir, ["checkout", "--force", head.replace(/^origin\//, "")]);
    await git(dir, ["reset", "--hard", head]);
  }
  const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
  return { dir, sha };
}

/** Fetch a specific commit (e.g. the previous reviewed SHA for an incremental diff). */
export async function ensureSha(dir: string, sha: string): Promise<void> {
  try {
    await git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    await git(dir, ["fetch", "--quiet", "origin", sha]);
  }
}

/** Is `sha` a commit present in this repo? (No network.) */
export async function commitExists(dir: string, sha: string): Promise<boolean> {
  try {
    await git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `ancestor` reachable from `descendant`? Used to detect a force-push/rebase: the previously
 * reviewed SHA is no longer in head's history, so an incremental diff would be wrong. Returns
 * false on "not an ancestor" AND on any git error (caller falls back to a full diff — the safe choice).
 */
export async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(dir, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Common ancestor of two commits — gives a clean PR diff (the changes head adds since
 * diverging from base, like GitHub's "Files changed"). Falls back to `a` on failure.
 */
export async function mergeBaseSafe(dir: string, a: string, b: string): Promise<string> {
  try {
    const out = (await git(dir, ["merge-base", a, b])).trim();
    return out || a;
  } catch {
    return a;
  }
}
