/**
 * Bound the inline patch handed to a runner.
 *
 * The whole `git diff` used to go into the prompt verbatim, so a single large PR could
 * exceed the engine's hard input limit and lose the review outright — observed live on
 * 2026-07-27: `codex exec` refused a 2,730,973-char input against its 1,048,576-char
 * ceiling ("input_too_large"), and the head was never reviewed. An oversized patch also
 * drives the run into the pipeline's 30-minute timeout.
 *
 * Capping is per FILE section: a file's patch is included whole or not at all, because a
 * patch truncated mid-hunk reads like a complete change and invites a confidently wrong
 * verdict. Files that do not fit are reported back so the prompt can name them and tell
 * the (agentic, checked-out) runner to read them itself — and so the review comment can
 * say honestly what was not inlined.
 */

/** One file's section of a unified diff, keyed by its post-image path. */
export interface PatchSection {
  path: string;
  text: string;
}

export interface CappedPatch {
  /** The patch to inline, containing only whole file sections. */
  patch: string;
  /** Paths whose section did not fit and was dropped (empty when nothing was dropped). */
  omittedFiles: string[];
  /** Total characters dropped. */
  omittedChars: number;
  truncated: boolean;
}

/** `diff --git a/<old> b/<new>` — the section boundary. Paths may contain spaces. */
const FILE_HEADER = /^diff --git a\/(.*) b\/(.+)$/;

/**
 * Split a unified diff into per-file sections. Anything before the first `diff --git`
 * header (normally nothing) is returned as a leading section with an empty path.
 */
export function splitPatchByFile(patch: string): PatchSection[] {
  if (!patch) return [];
  const sections: PatchSection[] = [];
  let current: PatchSection | null = null;
  const lines = patch.split("\n");

  for (const line of lines) {
    const m = FILE_HEADER.exec(line);
    if (m) {
      if (current) sections.push(current);
      current = { path: m[2] ?? m[1] ?? "", text: line };
      continue;
    }
    if (current) {
      current.text += `\n${line}`;
      continue;
    }
    // Preamble before any file header.
    current = { path: "", text: line };
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Keep whole file sections, in patch order, while they fit in `maxChars`; drop the rest.
 * A section too big for the budget is skipped and later (smaller) ones are still tried,
 * so one huge generated file cannot hide every other change in the PR.
 *
 * A non-positive `maxChars` disables capping.
 */
export function capPatch(patch: string, maxChars: number): CappedPatch {
  if (maxChars <= 0 || patch.length <= maxChars) {
    return { patch, omittedFiles: [], omittedChars: 0, truncated: false };
  }

  const sections = splitPatchByFile(patch);
  const kept: string[] = [];
  const omittedFiles: string[] = [];
  let used = 0;
  let omittedChars = 0;

  for (const s of sections) {
    // +1 for the newline this section costs when the kept sections are re-joined.
    const cost = s.text.length + (kept.length > 0 ? 1 : 0);
    if (used + cost <= maxChars) {
      kept.push(s.text);
      used += cost;
    } else {
      omittedChars += s.text.length;
      if (s.path) omittedFiles.push(s.path);
    }
  }

  return { patch: kept.join("\n"), omittedFiles, omittedChars, truncated: omittedChars > 0 };
}
