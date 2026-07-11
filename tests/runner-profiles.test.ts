import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PlatformConfig,
  RepoConfig,
  DEFAULT_RUNNER_PROFILES,
  resolveRunnerProfile,
  invalidProfileRunners,
  assertProfilesValid,
  setRepoRunnerProfile,
  loadRepoConfig,
  INLINE_PROFILE_NAME,
  type RunnerProfiles,
} from "../src/config";
import { selectRunnerSelector, type Signals } from "../src/apps/worker/policy";

const REGISTERED = ["claude-cli", "codex-cli", "anthropic-api"];
const signals: Signals = { changeType: "other", size: "small", risk: "low" };

describe("PlatformConfig.runnerProfiles default", () => {
  it("injects the starter profiles when platform.yaml omits the key", () => {
    const cfg = PlatformConfig.parse({});
    expect(Object.keys(cfg.runnerProfiles).sort()).toEqual(["claude-sonnet", "codex-gpt56-max", "fable-max"]);
    expect(cfg.runnerProfiles["fable-max"]).toEqual({
      runner: "claude-cli",
      model: "claude-fable-5",
      reasoningEffort: "max",
      description: expect.any(String),
    });
  });

  it("lets platform.yaml override the whole map", () => {
    const cfg = PlatformConfig.parse({ runnerProfiles: { mine: { runner: "codex-cli" } } });
    expect(Object.keys(cfg.runnerProfiles)).toEqual(["mine"]);
  });
});

describe("resolveRunnerProfile", () => {
  it("resolves a named profile to its runner/model/effort", () => {
    const runner = RepoConfig.parse({ repo: { id: "o/r" }, runner: { profile: "codex-gpt56-max" } }).runner;
    const active = resolveRunnerProfile(runner, DEFAULT_RUNNER_PROFILES);
    expect(active).toEqual({ name: "codex-gpt56-max", runner: "codex-cli", model: "gpt-5.6-sol", reasoningEffort: "max" });
  });

  it("falls back to the inline block when no profile is set (backward compat)", () => {
    const runner = RepoConfig.parse({
      repo: { id: "o/r" },
      runner: { default: "codex-cli", model: "gpt-5.5", reasoningEffort: "max" },
    }).runner;
    const active = resolveRunnerProfile(runner, DEFAULT_RUNNER_PROFILES);
    expect(active).toEqual({ name: INLINE_PROFILE_NAME, runner: "codex-cli", model: "gpt-5.5", reasoningEffort: "max" });
  });

  it("throws a clear error naming known profiles on an unknown name", () => {
    const runner = RepoConfig.parse({ repo: { id: "o/r" }, runner: { profile: "nope" } }).runner;
    expect(() => resolveRunnerProfile(runner, DEFAULT_RUNNER_PROFILES)).toThrowError(
      /Unknown runner profile "nope".*claude-sonnet, codex-gpt56-max, fable-max/,
    );
  });
});

describe("selectRunnerSelector (profile-aware)", () => {
  it("resolves the active profile into the selector's runner/model/effort", () => {
    const cfg = RepoConfig.parse({ repo: { id: "o/r" }, runner: { profile: "fable-max" } });
    const sel = selectRunnerSelector(cfg, signals, DEFAULT_RUNNER_PROFILES);
    expect(sel.preferred).toBe("claude-cli");
    expect(sel.model).toBe("claude-fable-5");
    expect(sel.reasoningEffort).toBe("max");
  });

  it("keeps working with a legacy inline runner block and no profiles", () => {
    const cfg = RepoConfig.parse({
      repo: { id: "o/r" },
      runner: { default: "codex-cli", model: "gpt-5.5", reasoningEffort: "high" },
    });
    const sel = selectRunnerSelector(cfg, signals); // profiles arg omitted
    expect(sel.preferred).toBe("codex-cli");
    expect(sel.model).toBe("gpt-5.5");
    expect(sel.reasoningEffort).toBe("high");
  });

  it("lets a matching change-signal override win over the profile", () => {
    const cfg = RepoConfig.parse({
      repo: { id: "o/r" },
      runner: {
        profile: "fable-max",
        overrides: [{ when: { size: "small", risk: "low" }, use: "codex-cli", model: "gpt-5.5" }],
      },
    });
    const sel = selectRunnerSelector(cfg, signals, DEFAULT_RUNNER_PROFILES);
    expect(sel.preferred).toBe("codex-cli");
    expect(sel.model).toBe("gpt-5.5");
  });

  it("throws when the repo pins an unknown profile", () => {
    const cfg = RepoConfig.parse({ repo: { id: "o/r" }, runner: { profile: "ghost" } });
    expect(() => selectRunnerSelector(cfg, signals, DEFAULT_RUNNER_PROFILES)).toThrow(/Unknown runner profile "ghost"/);
  });
});

describe("profile runner validation", () => {
  it("reports profiles whose runner is not registered", () => {
    const profiles: RunnerProfiles = { good: { runner: "claude-cli" }, bad: { runner: "made-up" } };
    expect(invalidProfileRunners(profiles, REGISTERED)).toEqual([{ name: "bad", runner: "made-up" }]);
  });

  it("assertProfilesValid throws on an unregistered runner, passes on the starters", () => {
    expect(() => assertProfilesValid(DEFAULT_RUNNER_PROFILES, REGISTERED)).not.toThrow();
    expect(() => assertProfilesValid({ x: { runner: "nope" } }, REGISTERED)).toThrowError(/unknown runner "nope"/);
  });
});

describe("setRepoRunnerProfile", () => {
  it("writes runner.profile and strips the superseded inline keys, keeping the file loadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-profiles-"));
    const path = join(dir, "repo.yaml");
    writeFileSync(
      path,
      [
        "repo:",
        "  id: owner/repo",
        "runner:",
        "  policy: cost_first",
        "  default: codex-cli",
        "  model: gpt-5.5",
        "  reasoningEffort: max",
        "  overrides: []",
        "",
      ].join("\n"),
    );

    setRepoRunnerProfile(path, "fable-max");

    const text = readFileSync(path, "utf8");
    expect(text).toContain("profile: fable-max");
    expect(text).not.toMatch(/^\s*default:/m);
    expect(text).not.toMatch(/^\s*model:/m);
    expect(text).not.toMatch(/^\s*reasoningEffort:/m);
    expect(text).toContain("policy: cost_first"); // untouched keys preserved

    const cfg = loadRepoConfig(path);
    expect(cfg.runner.profile).toBe("fable-max");
    const active = resolveRunnerProfile(cfg.runner, DEFAULT_RUNNER_PROFILES);
    expect(active).toEqual({ name: "fable-max", runner: "claude-cli", model: "claude-fable-5", reasoningEffort: "max" });
  });
});
