import { open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

const MAX_FILE_CHARS = 32_000;
const LOCAL_REFERENCE = /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py"];

interface Candidate {
  path: string;
  kind: "instructions" | "changed" | "related";
}

interface LoadedFile {
  text: string;
  truncated: boolean;
}

/**
 * Build a bounded, deterministic context bundle without asking Codex to read files itself.
 * This avoids the codex-cli SIGTRAP seen after multiple agentic file reads while preserving
 * the cross-file context that a diff-only review lacks.
 */
export async function collectWorkspaceReviewContext(
  workspaceDir: string,
  changedPaths: string[],
  maxChars: number,
): Promise<string> {
  if (maxChars <= 0) return "";

  let root: string;
  try {
    root = await realpath(workspaceDir);
  } catch {
    return "";
  }

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (path: string, kind: Candidate["kind"]) => {
    const normalized = posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
    if (!normalized || normalized === "." || normalized.startsWith("../") || isAbsolute(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ path: normalized, kind });
  };

  add("AGENTS.md", "instructions");
  for (const changedPath of changedPaths) {
    const normalized = posix.normalize(changedPath.replaceAll("\\", "/")).replace(/^\.\//, "");
    if (!normalized || normalized.startsWith("../") || isAbsolute(normalized)) continue;

    const parts = posix.dirname(normalized).split("/").filter((part) => part && part !== ".");
    for (let depth = 1; depth <= parts.length; depth++) {
      add(`${parts.slice(0, depth).join("/")}/AGENTS.md`, "instructions");
    }
    add(normalized, "changed");
  }

  const loaded = new Map<string, LoadedFile | null>();
  const load = async (path: string): Promise<LoadedFile | null> => {
    if (loaded.has(path)) return loaded.get(path) ?? null;
    const value = await readWorkspaceFile(root, path);
    loaded.set(path, value);
    return value;
  };

  // Resolve local imports and conventional neighboring tests from the changed files. The
  // candidates are appended after primary files, so a tight budget always favors instructions
  // and the actual files under review.
  for (const candidate of [...candidates]) {
    if (candidate.kind !== "changed") continue;
    const file = await load(candidate.path);
    if (!file) continue;

    for (const reference of localReferences(candidate.path, file.text)) add(reference, "related");
    for (const testPath of relatedTestPaths(candidate.path)) add(testPath, "related");
  }

  const sections: string[] = [];
  let used = 0;
  for (const candidate of candidates) {
    const file = await load(candidate.path);
    if (!file) continue;

    const label = candidate.kind === "instructions" ? "repository instructions" : candidate.kind === "changed" ? "changed file" : "related file";
    const truncation = file.truncated ? "\n[truncated by previewer]" : "";
    const header = `### ${candidate.path} (${label})\n<file path=${JSON.stringify(candidate.path)}>\n`;
    const footer = `${truncation}\n</file>`;
    const remaining = maxChars - used;
    if (remaining <= header.length + footer.length + 1) break;

    const text = file.text.slice(0, remaining - header.length - footer.length);
    sections.push(header + text + footer);
    used += header.length + text.length + footer.length;
    if (text.length < file.text.length) break;
  }

  return sections.join("\n\n");
}

async function readWorkspaceFile(root: string, repoPath: string): Promise<LoadedFile | null> {
  const unresolved = resolve(root, repoPath);
  if (!isWithin(root, unresolved)) return null;

  let actual: string;
  try {
    actual = await realpath(unresolved);
  } catch {
    return null;
  }
  if (!isWithin(root, actual)) return null; // Reject symlinks escaping the checkout.

  let handle;
  try {
    handle = await open(actual, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const bytesToRead = Math.min(stat.size, MAX_FILE_CHARS * 4);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return null;
    const decoded = bytes.toString("utf8");
    return { text: decoded.slice(0, MAX_FILE_CHARS), truncated: stat.size > bytesRead || decoded.length > MAX_FILE_CHARS };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function localReferences(sourcePath: string, text: string): string[] {
  const out: string[] = [];
  const sourceDir = posix.dirname(sourcePath);
  for (const match of text.matchAll(LOCAL_REFERENCE)) {
    const specifier = match[1]!;
    const base = posix.normalize(posix.join(sourceDir, specifier));
    if (posix.extname(base)) {
      out.push(base);
      continue;
    }
    for (const extension of SOURCE_EXTENSIONS) {
      out.push(base + extension, posix.join(base, `index${extension}`));
    }
  }
  return out.slice(0, 48);
}

function relatedTestPaths(sourcePath: string): string[] {
  const extension = posix.extname(sourcePath);
  if (!extension) return [];
  const dir = posix.dirname(sourcePath);
  const name = posix.basename(sourcePath, extension);

  if (name.endsWith(".test") || name.endsWith(".spec")) {
    return [posix.join(dir, name.replace(/\.(?:test|spec)$/, "") + extension)];
  }
  if (extension === ".go" && name.endsWith("_test")) {
    return [posix.join(dir, name.slice(0, -5) + extension)];
  }
  return [
    posix.join(dir, `${name}.test${extension}`),
    posix.join(dir, `${name}.spec${extension}`),
    posix.join(dir, "__tests__", `${name}${extension}`),
  ];
}
