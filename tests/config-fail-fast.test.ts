import { describe, it, expect } from "vitest";
import { RepoConfig, runnerConfigProblem, repoRunnerProblems, usableRunnerIds } from "../src/config";
import type { RunnerProfiles } from "../src/config";
import { classifyFailure, CONFIG_ERROR_PREFIX } from "../src/core";

/** Mirrors the real registry: two working CLI runners plus the registered-but-stub API runner. */
const RUNNERS = [
  { id: "claude-cli", implemented: true },
  { id: "codex-cli", implemented: true },
  { id: "anthropic-api", implemented: false },
];

const PROFILES: RunnerProfiles = {
  "codex-gpt56-max": { runner: "codex-cli", model: "gpt-5.6-sol", reasoningEffort: "max" },
  "ghost-runner": { runner: "gemini-cli" },
  "stub-profile": { runner: "anthropic-api" },
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

  it("rejects a repo that resolves onto a registered STUB runner", () => {
    // The dangerous shape: repo.yaml carried only `profile:` and that line went missing, so
    // resolution falls through to the `runner.default` zod fallback — `anthropic-api`, a value
    // nobody wrote in the file. It IS a registered id, so an id-only check passes; the review
    // then claims and `AnthropicApiRunner.review` throws, recording nothing at all.
    const problem = runnerConfigProblem(repo({}), PROFILES, RUNNERS);
    expect(problem).toContain("runner.default");
    expect(problem).toContain('"anthropic-api"');
    expect(problem).toContain("stub");
    // Names the consequence, not just the fact — this is what the operator reads at startup.
    expect(problem).toContain("after claiming");
  });

  it("rejects a stub reached through a profile, and through an override", () => {
    const viaProfile = runnerConfigProblem(repo({ profile: "stub-profile" }), PROFILES, RUNNERS);
    expect(viaProfile).toContain('profile "stub-profile"');
    expect(viaProfile).toContain("stub");

    const viaOverride = runnerConfigProblem(
      repo({ default: "claude-cli", overrides: [{ when: { size: "large" }, use: "anthropic-api" }] }),
      PROFILES,
      RUNNERS,
    );
    expect(viaOverride).toContain("runner override");
    expect(viaOverride).toContain("stub");
  });

  it("suggests only runners that would pass this same check, and reads as one sentence", () => {
    // A rejection whose "here are the valid ids" list contains an id this very function
    // rejects sends the operator straight back into the failure.
    const typo = runnerConfigProblem(repo({ default: "typo-cli" }), PROFILES, RUNNERS)!;
    expect(typo).not.toContain("anthropic-api");
    expect(typo).toContain("Available runners: claude-cli, codex-cli.");

    const stub = runnerConfigProblem(repo({}), PROFILES, RUNNERS)!;
    expect(stub).toContain('runner.default selects runner "anthropic-api", which is a stub');
    expect(stub).not.toContain("selects runner \"anthropic-api\" is a stub"); // no dangling verb
  });

  it("treats a runner that does not declare `implemented` as implemented", () => {
    // Back-compat: only a stub opts out. A runner list built without the flag must not read
    // as "everything is broken".
    expect(runnerConfigProblem(repo({ default: "some-cli" }), PROFILES, [{ id: "some-cli" }])).toBeNull();
  });

  it("catches a bad override before the diff that would trigger it arrives", () => {
    const cfg = repo({
      default: "claude-cli",
      overrides: [{ when: { size: "large" }, use: "nope-cli" }],
    });
    expect(runnerConfigProblem(cfg, PROFILES, RUNNERS)).toContain('unknown runner "nope-cli"');
  });
});

describe("usableRunnerIds", () => {
  it("excludes stubs, so every operator-facing list can share one definition of usable", () => {
    expect(usableRunnerIds(RUNNERS)).toEqual(["claude-cli", "codex-cli"]);
    expect(usableRunnerIds([{ id: "x" }])).toEqual(["x"]); // no flag = implemented
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
