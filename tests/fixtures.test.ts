import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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

  // Every platform file a checkout can boot on. `loadPlatformConfig` does NOT fall back on its own
  // — given a missing path it parses `{}` (src/config/index.ts) — the choice lives in the callers:
  // composeReviewDeps, composePlatform, composeOnboarding, the CLI and the dashboard all do
  // `existsSync("./config/platform.yaml") ? that : "./config/platform.example.yaml"`.
  // `config/platform.yaml` is TRACKED, so a fresh clone always takes the first branch and the
  // example is reached only if someone deletes it. Both ship, so both are checked — covering only
  // whichever one exists at test time would leave the other free to strand a clone.
  const SHIPPED_PLATFORM_FILES = ["config/platform.yaml", "config/platform.example.yaml"];
  const shippedProfileMaps = (): Array<[string, RunnerProfiles]> =>
    SHIPPED_PLATFORM_FILES.map((p) => {
      // `loadPlatformConfig` returns a FULLY DEFAULTED config for a path that does not exist
      // (src/config/index.ts: `existsSync(path) ? parse : {}`), so a renamed or mistyped entry here
      // would quietly become a second copy of the DEFAULT_RUNNER_PROFILES assertion below and stop
      // saying anything about the file a clone loads. Pin the existence, not just the contents.
      expect(existsSync(p), `${p} must ship`).toBe(true);
      return [p, loadPlatformConfig(p).runnerProfiles];
    });
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
    // Checked against EVERY shipped platform file, not just whichever one this checkout happens to
    // load: adding a `runnerProfiles:` block that drops a profile fails HERE rather than at a
    // clone's startup. The tracked map and DEFAULT_RUNNER_PROFILES coincide only while that key
    // stays absent — the zod `.default()` fires only when it is.
    const repos = listRepoConfigs("config/repos");
    for (const [file, profiles] of shippedProfileMaps()) {
      expect(repoRunnerProblems(repos, profiles, registeredRunnerIds()), file).toEqual([]);
    }
    expect(repoRunnerProblems(repos, DEFAULT_RUNNER_PROFILES, registeredRunnerIds())).toEqual([]);
  });

  it("every shipped profile targets a runner the registry actually has", () => {
    // Separate from the test above on purpose: this one involves no repo config at all, and
    // `expect` throws — folded together, a break in both would report only the first and understate
    // the damage. Mirrors `assertProfilesValid`, which runs in composeReviewDeps and composePlatform
    // (note: `runner list` and the dashboard read the same map WITHOUT that check, so a bad profile
    // prints happily there).
    // Reaches profiles no repo.yaml selects — `codex-gpt56-max` is shipped but unselected, and would
    // otherwise survive a `codex-cli` rename that breaks every fresh clone.
    for (const [file, profiles] of shippedProfileMaps()) {
      expect(invalidProfileRunners(profiles, registeredRunnerIds()), file).toEqual([]);
    }
    expect(invalidProfileRunners(DEFAULT_RUNNER_PROFILES, registeredRunnerIds())).toEqual([]);
  });

  it("the _example template a user is told to copy is itself runnable", () => {
    // `listRepoConfigs` skips `_`-prefixed dirs by design, so the checks above never see this file —
    // yet the README points users at it as the thing to copy. Its inline `default:` and its
    // override's `use:` are runner ids like any other, and a rename would ship a broken template
    // green while turning the live repos red.
    const template = loadRepoConfig(`${EX}/repo.yaml`);
    for (const [file, profiles] of shippedProfileMaps()) {
      expect(runnerConfigProblem(template, profiles, registeredRunnerIds()), file).toBeNull();
    }
  });
});
