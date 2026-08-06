import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  loadRepoConfig,
  listRepoConfigs,
  loadPlatformConfig,
  repoRunnerProblems,
  runnerConfigProblem,
  invalidProfileRunners,
  DEFAULT_RUNNER_PROFILES,
  RunnerProfiles,
  PackManifest,
  Routing,
  Profiles,
  Invariants,
  SecurityBaseline,
} from "../src/config";
import { createDefaultRunnerRegistry } from "../src/compose";

const EX = "config/repos/_example";
const pack = (name: string): unknown => parse(readFileSync(`${EX}/context-pack/${name}`, "utf8"));

describe("kourion-slice fixture validates against the schemas", () => {
  it("repo.yaml parses and applies defaults", () => {
    const cfg = loadRepoConfig(`${EX}/repo.yaml`);
    expect(cfg.repo.id).toBe("NickShtefan/kourion.fi");
    expect(cfg.review.incremental).toBe(true);
    expect(cfg.publish.formalReview).toBe(false);
  });

  it("every context-pack artifact parses", () => {
    expect(() => PackManifest.parse(pack("manifest.yaml"))).not.toThrow();
    expect(() => Routing.parse(pack("routing.yaml"))).not.toThrow();
    expect(() => Profiles.parse(pack("profiles.yaml"))).not.toThrow();
    expect(() => Invariants.parse(pack("invariants.yaml"))).not.toThrow();
    expect(() => SecurityBaseline.parse(pack("security-baseline.yaml"))).not.toThrow();
  });

  it("routing is additive and always includes security-baseline", () => {
    const r = Routing.parse(pack("routing.yaml"));
    expect(r.defaults.mandatoryProfiles).toContain("security-baseline");
    expect(r.routes.length).toBeGreaterThan(3);
    // base-symbol-contract activates multiple profiles that must merge as a union
    const baseSymbol = r.routes.find((x) => x.name === "base-symbol-contract");
    expect(baseSymbol?.activateProfiles.length).toBeGreaterThan(1);
  });

  it("profiles bundle docs and tests (the delta from kourion)", () => {
    const p = Profiles.parse(pack("profiles.yaml"));
    const meta = p.profiles["metadata-token-identity"];
    expect(meta?.docs.length).toBeGreaterThan(0);
    expect(meta?.tests.length).toBeGreaterThan(0);
  });

  it("invariants carry severity + reviewer questions", () => {
    const inv = Invariants.parse(pack("invariants.yaml"));
    const tokenId = inv.invariants.find((i) => i.id === "token-identity");
    expect(tokenId?.severity).toBe("high");
    expect(tokenId?.reviewerQuestions.length).toBeGreaterThan(0);
    const share = inv.invariants.find((i) => i.id === "public-share-privacy");
    expect(share?.severity).toBe("critical");
  });

  it("security baseline always carries the mandatory lens", () => {
    const sb = SecurityBaseline.parse(pack("security-baseline.yaml"));
    expect(sb.alwaysCheck).toContain("auth_session_regressions");
    expect(sb.alwaysCheck).toContain("supply_chain_secret_exposure");
  });

  it("loader skips `_`-prefixed template dirs but loads live repos", () => {
    const ids = listRepoConfigs("config/repos").map((c) => c.repo.id);
    expect(ids).toContain("NickShtefan/kourion.fi"); // the live dir loads
    // `_example` is skipped, so the live repo appears exactly once (not twice).
    expect(ids.filter((id) => id === "NickShtefan/kourion.fi")).toHaveLength(1);
  });

  // The profile config a FRESH CLONE actually runs on. `loadPlatformConfig` falls back to
  // `config/platform.example.yaml` whenever `config/platform.yaml` is absent (composeReviewDeps,
  // composePlatform, composeOnboarding, the CLI and the dashboard all do this), so the example file
  // is not documentation — it is the live map on a machine that has not been configured yet.
  const shippedProfiles = (): RunnerProfiles =>
    loadPlatformConfig("config/platform.example.yaml").runnerProfiles;
  const registeredRunnerIds = (): string[] =>
    createDefaultRunnerRegistry()
      .all()
      .map((c) => c.id);

  it("every shipped repo config names a profile a fresh clone can resolve", () => {
    // What this pins that nothing else does: the ON-DISK pairing of `config/repos/*/repo.yaml` with
    // the profiles a clone gets. Other suites cover each side alone — runner-profiles.test.ts pins
    // the built-in key list, cli-runner.test.ts pins the names in `runner list` output — but a typo
    // or a stale profile name in a SHIPPED repo.yaml is caught only here. Where a clone trips over
    // it depends on the entry point: `composePlatform` logs it per-repo and throws only when EVERY
    // enabled repo is broken, while a CLI review never reaches that check and fails inside
    // `runReviewPipeline`'s config gate instead.
    // Deliberately the shipped pair: a repo.yaml in git may not depend on an operator-local
    // platform.yaml, since a fresh clone has neither.
    expect(
      repoRunnerProblems(listRepoConfigs("config/repos"), shippedProfiles(), registeredRunnerIds()),
    ).toEqual([]);
    // Same pairing against the constant, so re-adding a `runnerProfiles:` block to the example that
    // drops a profile fails HERE rather than at a clone's startup — the two are equal only for as
    // long as that key stays absent, and the zod `.default()` fires only when it is.
    expect(
      repoRunnerProblems(
        listRepoConfigs("config/repos"),
        DEFAULT_RUNNER_PROFILES,
        registeredRunnerIds(),
      ),
    ).toEqual([]);
  });

  it("every shipped profile targets a runner the registry actually has", () => {
    // Separate from the test above on purpose: this one involves no repo config at all, and
    // `expect` throws — folded together, a break in both would report only the first and understate
    // the damage. Mirrors `assertProfilesValid`, which runs in composeReviewDeps and composePlatform
    // (note: `runner list` and the dashboard read the same map WITHOUT that check, so a bad profile
    // prints happily there).
    // Reaches profiles no repo.yaml selects — `codex-gpt56-max` is shipped but unselected, and would
    // otherwise survive a `codex-cli` rename that breaks every fresh clone.
    expect(invalidProfileRunners(shippedProfiles(), registeredRunnerIds())).toEqual([]);
    expect(invalidProfileRunners(DEFAULT_RUNNER_PROFILES, registeredRunnerIds())).toEqual([]);
  });

  it("the _example template a user is told to copy is itself runnable", () => {
    // `listRepoConfigs` skips `_`-prefixed dirs by design, so the checks above never see this file —
    // yet the README points users at it as the thing to copy. Its inline `default:` and its
    // override's `use:` are runner ids like any other, and a rename would ship a broken template
    // green while turning the live repos red.
    expect(
      runnerConfigProblem(loadRepoConfig(`${EX}/repo.yaml`), shippedProfiles(), registeredRunnerIds()),
    ).toBeNull();
  });
});
