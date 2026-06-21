import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitExists, isAncestor } from "../src/github";
import { LocalWorktreeProvider } from "../src/apps/worker/workspace";

const exec = promisify(execFile);
const g = (dir: string, args: string[]): Promise<{ stdout: string }> => exec("git", ["-C", dir, ...args]);

let dir: string;
let shaA: string; // base
let shaB: string; // ancestor of head (good incremental from-point)
let shaC: string; // head (linear A→B→C)
let shaX: string; // diverged from A (NOT an ancestor of C) — simulates a force-push

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "previewer-inc-"));
  await g(dir, ["init", "-q"]);
  await g(dir, ["config", "user.email", "t@t.t"]);
  await g(dir, ["config", "user.name", "tester"]);

  await writeFile(join(dir, "a.txt"), "v1\n");
  await g(dir, ["add", "."]);
  await g(dir, ["commit", "-q", "-m", "A"]);
  shaA = (await g(dir, ["rev-parse", "HEAD"])).stdout.trim();

  await writeFile(join(dir, "a.txt"), "v2\n");
  await g(dir, ["commit", "-qam", "B"]);
  shaB = (await g(dir, ["rev-parse", "HEAD"])).stdout.trim();

  await writeFile(join(dir, "a.txt"), "v3\n");
  await g(dir, ["commit", "-qam", "C"]);
  shaC = (await g(dir, ["rev-parse", "HEAD"])).stdout.trim();
  const main = (await g(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();

  // A divergent commit off A on another branch — not reachable from C.
  await g(dir, ["checkout", "-q", "-b", "divergent", shaA]);
  await writeFile(join(dir, "d.txt"), "x\n");
  await g(dir, ["add", "."]);
  await g(dir, ["commit", "-qm", "X"]);
  shaX = (await g(dir, ["rev-parse", "HEAD"])).stdout.trim();
  await g(dir, ["checkout", "-q", main]); // back to head = C
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("git ancestry helpers", () => {
  it("isAncestor / commitExists report history correctly", async () => {
    expect(await isAncestor(dir, shaB, shaC)).toBe(true); // B is in C's history
    expect(await isAncestor(dir, shaX, shaC)).toBe(false); // X diverged
    expect(await commitExists(dir, shaA)).toBe(true);
    expect(await commitExists(dir, "0".repeat(40))).toBe(false);
  });
});

describe("incremental diff fallback (LocalWorktreeProvider)", () => {
  it("keeps incremental when fromSha is an ancestor of head", async () => {
    const ws = await new LocalWorktreeProvider(dir).prepare("r", shaB, shaC, "incremental", shaA);
    try {
      expect(ws.diff.mode).toBe("incremental");
      expect(ws.diff.fromSha).toBe(shaB);
      expect(ws.diff.patch).toContain("v3"); // only the B→C change
      expect(ws.diff.patch).not.toContain("v1");
    } finally {
      await ws.cleanup();
    }
  });

  it("falls back to a full diff when fromSha is no longer in head's history (force-push)", async () => {
    const ws = await new LocalWorktreeProvider(dir).prepare("r", shaX, shaC, "incremental", shaA);
    try {
      expect(ws.diff.mode).toBe("full");
      expect(ws.diff.fromSha).toBe(shaA); // fell back to the base
      expect(ws.diff.patch).toContain("a.txt"); // full A→C range
    } finally {
      await ws.cleanup();
    }
  });

  it("falls back to a full diff when fromSha is missing entirely", async () => {
    const ws = await new LocalWorktreeProvider(dir).prepare("r", "0".repeat(40), shaC, "incremental", shaA);
    try {
      expect(ws.diff.mode).toBe("full");
      expect(ws.diff.fromSha).toBe(shaA);
    } finally {
      await ws.cleanup();
    }
  });
});
