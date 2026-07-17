import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCheckout } from "../src/github";

const exec = promisify(execFile);
const g = (dir: string, args: string[]) => exec("git", ["-C", dir, ...args]);

let workRoot: string;
let url: string; // a local repo acting as the clone source ("remote")
let sha: string;

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "previewer-checkout-"));
  const origin = join(workRoot, "origin");
  await mkdir(origin, { recursive: true });
  await g(origin, ["init", "-q"]);
  await g(origin, ["config", "user.email", "t@t.t"]);
  await g(origin, ["config", "user.name", "tester"]);
  await writeFile(join(origin, "f.txt"), "hello\n");
  await g(origin, ["add", "."]);
  await g(origin, ["commit", "-q", "-m", "init"]);
  sha = (await g(origin, ["rev-parse", "HEAD"])).stdout.trim();
  url = origin; // a local path is a valid clone source
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("ensureCheckout — crash-safe clone recovery", () => {
  it("clones fresh and checks out the sha when the dir is absent", async () => {
    const dir = join(workRoot, "fresh");
    await expect(ensureCheckout({ url, dir, sha })).resolves.toEqual({ dir });
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect((await g(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(sha);
  });

  it("recovers when a prior clone was interrupted (dir exists but is not a repo)", async () => {
    const dir = join(workRoot, "broken");
    // Simulate an interrupted clone: the dir exists (with junk) but is NOT a git repo. The old
    // existsSync gate would skip cloning and run `git fetch` in a non-repo -> unknown -> dead_letter.
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "partial.bin"), "half-written");
    await expect(ensureCheckout({ url, dir, sha })).resolves.toEqual({ dir });
    expect(existsSync(join(dir, ".git"))).toBe(true); // re-cloned into a valid repo
    expect((await g(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(sha);
    expect(existsSync(join(dir, "partial.bin"))).toBe(false); // the broken leftover was cleared
  });

  it("re-uses an existing valid checkout instead of re-cloning", async () => {
    const dir = join(workRoot, "reuse");
    await ensureCheckout({ url, dir, sha });
    // An untracked marker survives a fetch+checkout but not a re-clone (which rm's the dir).
    await writeFile(join(dir, "marker.txt"), "keep me");
    await ensureCheckout({ url, dir, sha });
    expect(existsSync(join(dir, "marker.txt"))).toBe(true); // same checkout re-used, not re-cloned
    expect((await g(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(sha);
  });

  it("leaves no half-built dir when the clone fails (bad url) — the retry can re-clone", async () => {
    const dir = join(workRoot, "clone-fails");
    await expect(
      ensureCheckout({ url: join(workRoot, "does-not-exist"), dir, sha }),
    ).rejects.toThrow();
    expect(existsSync(dir)).toBe(false); // no partial dir stranded for the next run to misread
  });

  it("does NOT accept a broken dir nested inside an ANCESTOR repo (would fetch/checkout the wrong repo)", async () => {
    // The workspace cache lives inside Previewer's own worktree. A broken cache dir nested in an
    // ancestor repo must be re-cloned, not treated as valid via the ancestor's .git — otherwise the
    // fetch/checkout would run against the parent repository (e.g. Previewer's live checkout).
    const parent = join(workRoot, "parent-repo");
    await mkdir(parent, { recursive: true });
    await g(parent, ["init", "-q"]);
    await g(parent, ["config", "user.email", "t@t.t"]);
    await g(parent, ["config", "user.name", "tester"]);
    await writeFile(join(parent, "root.txt"), "parent\n");
    await g(parent, ["add", "."]);
    await g(parent, ["commit", "-q", "-m", "parent"]);

    const dir = join(parent, "nested-cache"); // exists, inside parent's repo, but not its OWN repo
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "junk"), "not a repo");

    await ensureCheckout({ url, dir, sha });
    // Re-cloned into its OWN repo (toplevel == dir), NOT resolving the parent's .git.
    const top = (await g(dir, ["rev-parse", "--show-toplevel"])).stdout.trim();
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect((await g(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(sha);
    expect(top.endsWith("nested-cache")).toBe(true); // its own toplevel, not the parent repo
  });
});
