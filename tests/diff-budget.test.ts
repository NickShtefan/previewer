import { describe, it, expect } from "vitest";
import { capPatch, splitPatchByFile } from "../src/apps/worker/diff-budget";

/** A minimal but realistic file section of a unified diff. */
function fileSection(path: string, bodyLines: number): string {
  const body = Array.from({ length: bodyLines }, (_, i) => `+line ${i}`).join("\n");
  return [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${bodyLines} @@`,
    body,
  ].join("\n");
}

describe("splitPatchByFile", () => {
  it("splits on file headers and keys sections by the post-image path", () => {
    const patch = [fileSection("src/a.ts", 2), fileSection("src/b.ts", 2)].join("\n");
    const sections = splitPatchByFile(patch);
    expect(sections.map((s) => s.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(sections[0].text.startsWith("diff --git a/src/a.ts")).toBe(true);
    expect(sections.map((s) => s.text).join("\n")).toBe(patch);
  });

  it("uses the b/ path for a rename, and keeps a preamble as a pathless section", () => {
    const renamed = [
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 95%",
      "rename from old/name.ts",
      "rename to new/name.ts",
    ].join("\n");
    expect(splitPatchByFile(renamed)[0].path).toBe("new/name.ts");

    const withPreamble = `stray preamble\n${fileSection("src/a.ts", 1)}`;
    expect(splitPatchByFile(withPreamble).map((s) => s.path)).toEqual(["", "src/a.ts"]);
  });

  it("returns nothing for an empty patch", () => {
    expect(splitPatchByFile("")).toEqual([]);
  });
});

describe("capPatch", () => {
  it("passes a patch within budget through untouched", () => {
    const patch = [fileSection("src/a.ts", 3), fileSection("src/b.ts", 3)].join("\n");
    const capped = capPatch(patch, patch.length);
    expect(capped.patch).toBe(patch);
    expect(capped.truncated).toBe(false);
    expect(capped.omittedFiles).toEqual([]);
    expect(capped.omittedChars).toBe(0);
  });

  it("drops whole file sections — never a partial hunk — and names what it dropped", () => {
    const a = fileSection("src/a.ts", 3);
    const b = fileSection("src/b.ts", 400);
    const capped = capPatch([a, b].join("\n"), a.length + 10);

    expect(capped.patch).toBe(a);
    expect(capped.omittedFiles).toEqual(["src/b.ts"]);
    expect(capped.truncated).toBe(true);
    expect(capped.omittedChars).toBe(b.length);
    // Every kept file header still has its hunk body: no section was cut mid-way.
    expect(capped.patch.split("diff --git").length - 1).toBe(1);
    expect(capped.patch.endsWith("+line 2")).toBe(true);
  });

  it("keeps later smaller files after skipping one that cannot fit", () => {
    const huge = fileSection("generated/bundle.js", 5000);
    const small = fileSection("src/auth.ts", 3);
    const capped = capPatch([huge, small].join("\n"), small.length + 50);

    // The one file a reviewer actually cares about survives the giant generated blob.
    expect(capped.patch).toBe(small);
    expect(capped.omittedFiles).toEqual(["generated/bundle.js"]);
  });

  it("omits everything when no single section fits", () => {
    const patch = [fileSection("src/a.ts", 100), fileSection("src/b.ts", 100)].join("\n");
    const capped = capPatch(patch, 50);
    expect(capped.patch).toBe("");
    expect(capped.omittedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(capped.truncated).toBe(true);
  });

  it("treats a non-positive budget as no cap", () => {
    const patch = fileSection("src/a.ts", 10);
    expect(capPatch(patch, 0).patch).toBe(patch);
    expect(capPatch(patch, 0).truncated).toBe(false);
  });
});
