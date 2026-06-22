import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDependencyInstaller } from "../src/apps/worker/install";
import type { CliExecutor, CliResult } from "../src/runners";

let calls: Array<{ cmd: string; args: string[]; cwd?: string }>;
const fakeExec: CliExecutor = {
  async run(cmd, args, opts): Promise<CliResult> {
    calls.push({ cmd, args, cwd: opts?.cwd });
    return { stdout: "", stderr: "", exitCode: 0 };
  },
};

let dir: string;

beforeEach(async () => {
  calls = [];
  dir = await mkdtemp(join(tmpdir(), "previewer-install-"));
  // root: npm
  await writeFile(join(dir, "package.json"), "{}");
  await writeFile(join(dir, "package-lock.json"), "{}");
  // api/: pnpm, needs install
  await mkdir(join(dir, "api"), { recursive: true });
  await writeFile(join(dir, "api", "package.json"), "{}");
  await writeFile(join(dir, "api", "pnpm-lock.yaml"), "");
  // web/: yarn but already has node_modules -> reused/skipped
  await mkdir(join(dir, "web", "node_modules"), { recursive: true });
  await writeFile(join(dir, "web", "package.json"), "{}");
  await writeFile(join(dir, "web", "yarn.lock"), "");
  // docs/: no package.json -> ignored entirely
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs", "readme.md"), "x");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("NodeDependencyInstaller", () => {
  it("installs root + monorepo subdirs by lockfile, reuses existing node_modules", async () => {
    const res = await new NodeDependencyInstaller(fakeExec).install(dir);

    expect(res.installedDirs).toEqual([dir, join(dir, "api")]);
    expect(res.skipped).toContain(join(dir, "web")); // node_modules present
    expect(res.failed).toEqual([]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ cmd: "npm", args: ["ci"], cwd: dir });
    expect(calls[1]).toMatchObject({ cmd: "pnpm", args: ["install", "--frozen-lockfile"], cwd: join(dir, "api") });
  });

  it("records a failure (non-zero exit) without throwing", async () => {
    const failing: CliExecutor = { async run() { return { stdout: "", stderr: "boom", exitCode: 1 }; } };
    const res = await new NodeDependencyInstaller(failing).install(dir);
    expect(res.failed).toContain(dir);
    expect(res.installedDirs).not.toContain(dir);
  });
});
