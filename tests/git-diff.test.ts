import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiff, sizeClassOf, languageOf } from "../src/github";

const exec = promisify(execFile);
const g = (dir: string, args: string[]) => exec("git", ["-C", dir, ...args]);

let dir: string;
let shaA: string;
let shaB: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "previewer-git-"));
  await g(dir, ["init", "-q"]);
  await g(dir, ["config", "user.email", "t@t.t"]);
  await g(dir, ["config", "user.name", "tester"]);

  await writeFile(join(dir, "keep.txt"), "line1\nline2\n");
  await writeFile(join(dir, "remove.txt"), "old\n");
  await g(dir, ["add", "."]);
  await g(dir, ["commit", "-q", "-m", "A"]);
  shaA = (await g(dir, ["rev-parse", "HEAD"])).stdout.trim();

  await writeFile(join(dir, "keep.txt"), "line1\nline2\nline3\n"); // +1
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "new.ts"), "export const x = 1;\n"); // added
  await rm(join(dir, "remove.txt")); // removed
  await g(dir, ["add", "-A"]);
  await g(dir, ["commit", "-q", "-m", "B"]);
  shaB = (await g(dir, ["rev-parse", "HEAD"])).stdout.trim();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("gitDiff", () => {
  it("computes patch + changed files (status, numstat, language)", async () => {
    const { patch, changedFiles } = await gitDiff(dir, shaA, shaB);
    expect(patch).toContain("src/new.ts");

    const byPath = Object.fromEntries(changedFiles.map((f) => [f.path, f]));
    expect(byPath["src/new.ts"]!.status).toBe("added");
    expect(byPath["src/new.ts"]!.additions).toBe(1);
    expect(byPath["src/new.ts"]!.language).toBe("typescript");
    expect(byPath["keep.txt"]!.status).toBe("modified");
    expect(byPath["keep.txt"]!.additions).toBe(1);
    expect(byPath["remove.txt"]!.status).toBe("removed");
    expect(byPath["remove.txt"]!.deletions).toBe(1);
  });
});

describe("classifiers", () => {
  it("sizeClassOf buckets by total churn", () => {
    expect(sizeClassOf(3)).toBe("tiny");
    expect(sizeClassOf(20)).toBe("small");
    expect(sizeClassOf(100)).toBe("medium");
    expect(sizeClassOf(2000)).toBe("huge");
  });
  it("languageOf maps known extensions, undefined otherwise", () => {
    expect(languageOf("a/b.ts")).toBe("typescript");
    expect(languageOf("q.sql")).toBe("sql");
    expect(languageOf("x.unknownext")).toBeUndefined();
  });
});
