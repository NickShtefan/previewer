import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * End-to-end coverage of the `runner list` / `runner use` CLI subcommands: spawns the real CLI
 * against a throwaway config tree so the argument parsing, profile lookup, active-client resolution,
 * and repo.yaml rewrite are all exercised together.
 */
const REPO_ROOT = process.cwd();
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI = join(REPO_ROOT, "src", "apps", "cli", "main.ts");

function makeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-runner-"));
  mkdirSync(join(dir, "config", "repos", "owner__repo"), { recursive: true });
  // platform.yaml WITHOUT runnerProfiles -> the built-in starter profiles apply.
  writeFileSync(join(dir, "config", "platform.yaml"), "defaultLanguage: en\nlogLevel: info\n");
  writeFileSync(
    join(dir, "config", "repos", "owner__repo", "repo.yaml"),
    ["repo:", "  id: owner/repo", "runner:", "  policy: cost_first", "  default: codex-cli", "  model: gpt-5.5", "  reasoningEffort: max", ""].join("\n"),
  );
  return dir;
}

function runCli(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(TSX, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("cli: runner list / use", () => {
  beforeAll(() => {
    if (!existsSync(TSX)) throw new Error(`tsx not found at ${TSX} - run npm install`);
  });

  it("list shows the starter profiles and the repo's active inline client", () => {
    const dir = makeConfigDir();
    const { status, stdout } = runCli(dir, "runner", "list");
    expect(status).toBe(0);
    expect(stdout).toContain("fable-max");
    expect(stdout).toContain("codex-gpt56-max");
    expect(stdout).toContain("claude-sonnet");
    // active-client section: repo still on inline codex-cli/gpt-5.5
    expect(stdout).toContain("owner/repo");
    expect(stdout).toMatch(/codex-cli \/ gpt-5\.5.*\(inline\)/);
  }, 30000);

  it("use switches the repo to a profile and list reflects it", () => {
    const dir = makeConfigDir();
    const use = runCli(dir, "runner", "use", "fable-max", "--repo", "owner/repo");
    expect(use.status).toBe(0);
    expect(use.stdout).toContain('review client -> profile "fable-max"');

    const repoYaml = readFileSync(join(dir, "config", "repos", "owner__repo", "repo.yaml"), "utf8");
    expect(repoYaml).toContain("profile: fable-max");
    expect(repoYaml).not.toMatch(/^\s*default:/m);

    const list = runCli(dir, "runner", "list");
    expect(list.stdout).toMatch(/owner\/repo.*claude-cli \/ claude-fable-5.*\(profile fable-max\)/);
  }, 30000);

  it("use rejects an unknown profile with a non-zero exit and clear error", () => {
    const dir = makeConfigDir();
    const { status, stderr } = runCli(dir, "runner", "use", "ghost", "--repo", "owner/repo");
    expect(status).toBe(1);
    expect(stderr).toContain('Unknown profile "ghost"');
  }, 30000);
});
