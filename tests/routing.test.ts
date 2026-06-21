import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack, resolveContext, globMatch } from "../src/context";
import { ConfigError } from "../src/core";
import type { ChangedFile } from "../src/config";

const PACK_DIR = "config/repos/_example/context-pack";
const REPO = "NickShtefan/kourion.fi";
const cf = (path: string): ChangedFile => ({
  path,
  status: "modified",
  additions: 3,
  deletions: 1,
  sizeClass: "small",
});

describe("globMatch", () => {
  it("handles **, *, and literals", () => {
    expect(globMatch("api/src/services/metadata/**", "api/src/services/metadata/index.ts")).toBe(true);
    expect(globMatch("**/*.sql", "api/prisma/x.sql")).toBe(true);
    expect(globMatch("api/src/routes/share*.ts", "api/src/routes/sharePage.ts")).toBe(true);
    expect(globMatch("**", "anything/here.ts")).toBe(true);
    expect(globMatch("web/**", "api/foo.ts")).toBe(false);
  });
});

describe("loadPack — kourion fixture", () => {
  const pack = loadPack(PACK_DIR, REPO);

  it("assembles a valid pack with subsystems parsed from markdown", () => {
    expect(pack.repo).toBe(REPO);
    expect(pack.routing.routes.length).toBeGreaterThan(3);
    expect(Object.keys(pack.profiles.profiles)).toContain("security-baseline");
    expect(pack.subsystems.map((s) => s.name).sort()).toEqual(["api", "metadata", "web"]);
    const meta = pack.subsystems.find((s) => s.name === "metadata")!;
    expect(meta.path).toBe("api/src/services/metadata");
    expect(meta.risk).toBe("high");
  });
});

describe("resolveContext — additive routing on the fixture", () => {
  const pack = loadPack(PACK_DIR, REPO);

  it("metadata change → metadata-token-identity + mandatory security-baseline, with docs/tests/invariants", () => {
    const r = resolveContext(pack, [cf("api/src/services/metadata/cache.ts")]);
    expect(r.activeProfiles.sort()).toEqual(["metadata-token-identity", "security-baseline"]);
    expect(r.tests.some((t) => t.includes("scannerSync.tokenId"))).toBe(true);
    expect(r.requiredDocs).toContain("api/src/services/metadata/AGENTS.md");
    expect(r.invariants.map((i) => i.id)).toContain("token-identity");
    expect(r.subsystems.map((s) => s.name).sort()).toEqual(["api", "metadata"]);
  });

  it("the metadata seam file (index.ts) is also an architecture boundary — both profiles activate", () => {
    // index.ts matches BOTH `metadata-and-pricing` and `schema-infra-and-boundaries`
    // routes, so the additive union pulls in architecture-boundaries too.
    const r = resolveContext(pack, [cf("api/src/services/metadata/index.ts")]);
    expect(r.activeProfiles.sort()).toEqual([
      "architecture-boundaries",
      "metadata-token-identity",
      "security-baseline",
    ]);
  });

  it("a cross-cutting PR merges the union of matched profiles (no dups)", () => {
    const r = resolveContext(pack, [
      cf("api/src/routes/share.ts"),
      cf("web/src/components/share/ShareSheet.tsx"),
    ]);
    expect(r.activeProfiles.sort()).toEqual(["frontend-surface", "security-baseline", "share-privacy"]);
  });

  it("security-baseline is always active, even with no route match", () => {
    const r = resolveContext(pack, [cf("README.md")]);
    expect(r.activeProfiles).toEqual(["security-baseline"]);
    expect(r.securityBaseline.alwaysCheck).toContain("privacy_boundary_leaks");
    expect(r.subsystems).toHaveLength(0);
  });
});

describe("loadPack — rejects an inconsistent pack", () => {
  it("throws ConfigError when a route references an unknown profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "previewer-pack-"));
    const pd = join(dir, "context-pack");
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "manifest.yaml"), "version: 1\ngeneratedAt: x\n");
    writeFileSync(
      join(pd, "routing.yaml"),
      "version: 1\nroutes:\n  - name: r\n    paths: ['src/**']\n    activateProfiles: [does-not-exist]\n",
    );
    writeFileSync(join(pd, "profiles.yaml"), "profiles:\n  security-baseline:\n    focus: []\n");
    writeFileSync(join(pd, "invariants.yaml"), "invariants: []\n");
    writeFileSync(join(pd, "security-baseline.yaml"), "alwaysCheck: [data_leaks]\n");

    expect(() => loadPack(pd, "x/y")).toThrow(ConfigError);
    rmSync(dir, { recursive: true, force: true });
  });
});
