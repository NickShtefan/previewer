import { describe, it, expect } from "vitest";
import { RepoConfig, runnerConfigProblem, repoRunnerProblems } from "../src/config";
import type { RunnerProfiles } from "../src/config";
import { classifyFailure, CONFIG_ERROR_PREFIX } from "../src/core";

const RUNNERS = ["claude-cli", "codex-cli", "anthropic-api"];

const PROFILES: RunnerProfiles = {
  "codex-gpt56-max": { runner: "codex-cli", model: "gpt-5.6-sol", reasoningEffort: "max" },
  "ghost-runner": { runner: "gemini-cli" },
};

const repo = (runner: Record<string, unknown>): RepoConfig =>
  RepoConfig.parse({ repo: { id: "owner/repo" }, runner });

describe("runnerConfigProblem", () => {
  it("passes a repo whose profile resolves to a registered runner", () => {
    expect(runnerConfigProblem(repo({ profile: "codex-gpt56-max" }), PROFILES, RUNNERS)).toBeNull();
  });

  it("passes a repo still on the inline runner block", () => {
    expect(runnerConfigProblem(repo({ default: "claude-cli" }), PROFILES, RUNNERS)).toBeNull();
  });

  it("reports a profile name that does not exist, and lists the ones that do", () => {
    // The live case: platform.yaml lost the profile a repo.yaml still points at. Deliberately a
    // name that is NOT a shipped starter profile — using a real one (`opus5-max`) would read as a
    // contradiction and invite a future reader to "fix" it by adding it to PROFILES, which would
    // silently delete this assertion.
    const problem = runnerConfigProblem(repo({ profile: "ghost-profile" }), PROFILES, RUNNERS);
    expect(problem).toContain('Unknown runner profile "ghost-profile"');
    expect(problem).toContain("codex-gpt56-max");
  });

  it("reports a profile that targets a runner the platform cannot run", () => {
    const problem = runnerConfigProblem(repo({ profile: "ghost-runner" }), PROFILES, RUNNERS);
    expect(problem).toContain('profile "ghost-runner"');
    expect(problem).toContain('unknown runner "gemini-cli"');
    expect(problem).toContain("claude-cli, codex-cli");
  });

  it("reports an inline default that is not a registered runner", () => {
    const problem = runnerConfigProblem(repo({ default: "typo-cli" }), PROFILES, RUNNERS);
    expect(problem).toContain("runner.default");
    expect(problem).toContain('unknown runner "typo-cli"');
  });

  it("catches a bad override before the diff that would trigger it arrives", () => {
    const cfg = repo({
      default: "claude-cli",
      overrides: [{ when: { size: "large" }, use: "nope-cli" }],
    });
    expect(runnerConfigProblem(cfg, PROFILES, RUNNERS)).toContain('unknown runner "nope-cli"');
  });
});

describe("repoRunnerProblems", () => {
  it("returns one entry per broken repo and nothing for healthy ones", () => {
    const good = RepoConfig.parse({ repo: { id: "owner/good" }, runner: { default: "claude-cli" } });
    const bad = RepoConfig.parse({ repo: { id: "owner/bad" }, runner: { profile: "missing" } });

    expect(repoRunnerProblems([good], PROFILES, RUNNERS)).toEqual([]);
    const problems = repoRunnerProblems([good, bad], PROFILES, RUNNERS);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.repo).toBe("owner/bad");
  });
});

describe("classifyFailure — config errors", () => {
  it("classifies a stamped config error as transient so the head is never lost", () => {
    // Transient, not permanent: retrying is free (the pipeline bails before the claim, GitHub,
    // and the model) and self-heals the moment the operator fixes the config. Dead-lettering
    // would strand every PR pushed during the misconfiguration — the queue dedupes on head SHA,
    // so a dead-lettered job is never re-enqueued.
    expect(classifyFailure(`${CONFIG_ERROR_PREFIX} owner/repo: Unknown runner profile "x".`)).toBe("transient");
  });

  it("does not sweep in unrelated text that merely mentions config", () => {
    expect(classifyFailure("failed to load some config file")).toBe("unknown");
  });
});
