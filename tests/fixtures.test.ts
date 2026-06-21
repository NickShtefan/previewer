import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  loadRepoConfig,
  listRepoConfigs,
  PackManifest,
  Routing,
  Profiles,
  Invariants,
  SecurityBaseline,
} from "../src/config";

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
});
