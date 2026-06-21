import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OnboardingPipeline,
  buildInventory,
  discoverContext,
  assessArtifacts,
  loadPack,
  writePack,
  reconcileRoutingProfiles,
} from "../src/context";
import { Routing, Profiles, Invariant, OnboardingInput } from "../src/config";
import type {
  PackGenerator,
  OnboardingGenerationRequest,
  PackGenerationResult,
  GeneratedArtifacts,
  RunLogger,
} from "../src/core";

const silent: RunLogger = { info() {}, warn() {}, error() {} };

/** A rich root guide: long, path-dense, references files that exist -> scores high (ingest). */
const AGENTS_MD = `# Acme Widget Agent Guide

## Product
Acme Widget is a billing + API service. Financial correctness and privacy come first.

## Repo map
- \`api/server.ts\` — HTTP entry, the system of record.
- \`web/index.tsx\` — React UI.
- \`src/index.ts\` — shared library entry.
- \`api/AGENTS.md\` — backend-specific guidance.

## Architecture
The API in \`api/server.ts\` owns persistence and auth. The web app in \`web/index.tsx\`
reflects backend truth and never recomputes finance in the browser. Shared helpers live in
\`src/index.ts\`. Read \`docs/reviewer/comment-template.md\` for the review format.

## Conventions
Extend existing seams in \`api/server.ts\` over parallel helpers; keep handlers thin; never
log secrets; preserve invariant comments. Tests run with \`npm test\`. Migrations live under
\`api/server.ts\` adjacent modules. Do not refactor finance code opportunistically.

## Nested guides
Follow \`api/AGENTS.md\` for backend changes.
`;

async function seedRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "previewer-onboard-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "widget",
      scripts: { test: "vitest run" },
      dependencies: { react: "^18.0.0", express: "^4.18.0" },
      devDependencies: { vitest: "^2.0.0", typescript: "^5.0.0" },
    }),
  );
  await writeFile(join(dir, "package-lock.json"), "{}");
  await writeFile(join(dir, "tsconfig.json"), "{}");
  await mkdir(join(dir, ".github", "workflows"), { recursive: true });
  await writeFile(join(dir, ".github", "workflows", "ci.yml"), "name: ci\non: [push]\n");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");
  await writeFile(join(dir, "src", "util.ts"), "export const y = 2;\n");
  await mkdir(join(dir, "api"), { recursive: true });
  await writeFile(join(dir, "api", "server.ts"), "export const app = {};\n");
  await mkdir(join(dir, "web"), { recursive: true });
  await writeFile(join(dir, "web", "index.tsx"), "export const App = () => null;\n");
  await writeFile(join(dir, "AGENTS.md"), AGENTS_MD);
  await writeFile(join(dir, "api", "AGENTS.md"), "# Acme API Guide\n\nThis file applies to everything under `api/`. It owns auth and billing.\n");
  await mkdir(join(dir, "docs", "reviewer"), { recursive: true });
  await writeFile(join(dir, "docs", "reviewer", "comment-template.md"), "## Review\n{findings}\n<!-- ai-review:{repo}#{pr}@{head_sha} -->\n");
  return dir;
}

const genArtifacts = (invariants: Invariant[]): GeneratedArtifacts => ({
  routing: Routing.parse({
    version: 1,
    defaults: { mandatoryProfiles: ["security-baseline"], requiredContext: ["AGENTS.md"] },
    routes: [{ name: "api", paths: ["api/**"], activateProfiles: ["api-correctness"] }],
    notes: ["if api/ and web/ both change, check contract drift"],
  }),
  profiles: Profiles.parse({
    profiles: {
      "security-baseline": { depth: "normal", focus: ["data_leak"], docs: ["AGENTS.md"], tests: [], runTests: false },
      "api-correctness": { depth: "deep", focus: ["contracts"], docs: ["api/AGENTS.md"], tests: ["npm test"], runTests: true },
    },
  }),
  invariants,
});

class FakeGenerator implements PackGenerator {
  calls: OnboardingGenerationRequest[] = [];
  constructor(
    private readonly artifacts: GeneratedArtifacts,
    private readonly opts: { throws?: boolean } = {},
  ) {}
  async generate(req: OnboardingGenerationRequest): Promise<PackGenerationResult> {
    this.calls.push(req);
    if (this.opts.throws) throw new Error("generation boom");
    return { artifacts: this.artifacts, model: "fake-model", cost: { tokens: 1234, usd: 0.02 } };
  }
}

const NO_EVAL = Invariant.parse({
  id: "no-eval",
  rule: "Never eval untrusted input",
  appliesTo: ["**"],
  severity: "high",
  reviewerQuestions: ["does this eval untrusted input?"],
});

function makePipeline(reposDir: string, generator: PackGenerator): OnboardingPipeline {
  return new OnboardingPipeline({
    generator,
    reposDir,
    language: "en",
    logger: silent,
    now: () => new Date("2026-06-22T00:00:00.000Z"),
  });
}

let repoDir: string;
let reposDir: string;

beforeEach(async () => {
  repoDir = await seedRepo();
  reposDir = await mkdtemp(join(tmpdir(), "previewer-repos-"));
});
afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(reposDir, { recursive: true, force: true });
});

describe("inventory (deterministic, model-free)", () => {
  it("detects languages, frameworks, package manager, CI, test, entrypoints, modules", () => {
    const inv = buildInventory(repoDir);
    expect(inv.languages).toContain("typescript");
    expect(inv.frameworks).toEqual(expect.arrayContaining(["express", "react"]));
    expect(inv.packageManagers).toContain("npm");
    expect(inv.ci).toContain("github-actions");
    expect(inv.test.framework).toBe("vitest");
    expect(inv.test.command).toBe("npm test");
    expect(inv.entrypoints).toContain("src/index.ts");
    const api = inv.modules.find((m) => m.path === "api");
    expect(api?.risk).toBe("high");
    expect(inv.modules.map((m) => m.name)).toEqual(expect.arrayContaining(["api", "web", "src"]));
  });
});

describe("discover + assess (use-existing vs generate)", () => {
  it("finds the AGENTS hierarchy + comment template and decides per artifact", () => {
    const d = discoverContext(repoDir);
    expect(d.rootAgents?.path).toBe("AGENTS.md");
    expect(d.nestedAgents.map((x) => x.path)).toEqual(["api/AGENTS.md"]);
    expect(d.commentTemplate?.path).toBe("docs/reviewer/comment-template.md");

    const { plans } = assessArtifacts(repoDir, d, 0.7);
    const decision = (name: string): string => plans.find((p) => p.artifact === name)!.decision;
    expect(decision("repoGuide")).toBe("ingest"); // rich, fresh AGENTS.md
    expect(decision("subsystems")).toBe("ingest"); // nested AGENTS.md
    expect(decision("commentTemplate")).toBe("ingest");
    expect(decision("routing")).toBe("generate");
    expect(decision("profiles")).toBe("generate");
    expect(decision("invariants")).toBe("generate");
  });
});

describe("OnboardingPipeline.run", () => {
  it("ingests existing context, generates only structured artifacts, and writes a valid pack", async () => {
    const gen = new FakeGenerator(genArtifacts([NO_EVAL]));
    const pipeline = makePipeline(reposDir, gen);
    const result = await pipeline.run(
      OnboardingInput.parse({ repo: "acme/widget", workspaceDir: repoDir, useExistingThreshold: 0.7 }),
    );

    // The model was asked ONLY for the structured artifacts; ingested ones never hit the model.
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]!.targets.sort()).toEqual(["invariants", "profiles", "routing"]);

    expect(result.status).toBe("needs_review"); // generated invariant awaits confirmation
    expect(result.contextPack.ref).toBe("context-pack@v1");
    expect(result.contextPack.decisions.repoGuide).toBe("ingest");
    expect(result.contextPack.decisions.routing).toBe("generate");
    expect(result.openQuestions.some((q) => q.includes("no-eval"))).toBe(true);
    expect(result.cost).toEqual({ tokens: 1234, usd: 0.02 });
    expect(result.existingContext.found.map((f) => f.path)).toContain("AGENTS.md");

    // The persisted pack round-trips through loadPack.
    const destDir = join(reposDir, "acme__widget", "context-pack");
    const pack = loadPack(destDir, "acme/widget");
    expect(pack.repoGuide).toBe(AGENTS_MD);
    expect(pack.subsystems.map((s) => s.name)).toContain("api");
    expect(pack.routing.routes.map((r) => r.name)).toEqual(["api"]);
    expect(Object.keys(pack.profiles.profiles).sort()).toEqual(["api-correctness", "security-baseline"]);
    const inv = pack.invariants.invariants.find((i) => i.id === "no-eval");
    expect(inv?.status).toBe("needs_confirmation"); // human-confirm gate
    expect(pack.manifest.version).toBe(1);
    expect(pack.manifest.provenance.repoGuide?.source).toBe("ingested");
    expect(pack.manifest.provenance.repoGuide?.from).toBe("AGENTS.md");
    expect(pack.manifest.provenance.routing?.source).toBe("generated");

    // repo.yaml was scaffolded.
    const back = loadPack(destDir, "acme/widget");
    expect(back.repo).toBe("acme/widget");
  });

  it("dry-run computes the result but writes nothing", async () => {
    const pipeline = makePipeline(reposDir, new FakeGenerator(genArtifacts([NO_EVAL])));
    const result = await pipeline.run(
      OnboardingInput.parse({ repo: "acme/widget", workspaceDir: repoDir }),
      { persist: false },
    );
    expect(result.contextPack.ref).toBe("context-pack@v1");
    expect(() => loadPack(join(reposDir, "acme__widget", "context-pack"), "acme/widget")).toThrow();
  });

  it("re-onboarding bumps the version and preserves confirmed invariants", async () => {
    const input = OnboardingInput.parse({ repo: "acme/widget", workspaceDir: repoDir });

    // Run 1: approve the generated invariant.
    await makePipeline(reposDir, new FakeGenerator(genArtifacts([NO_EVAL]))).run(input, { confirmInvariants: true });
    const pack1 = loadPack(join(reposDir, "acme__widget", "context-pack"), "acme/widget");
    expect(pack1.manifest.version).toBe(1);
    expect(pack1.invariants.invariants.find((i) => i.id === "no-eval")?.status).toBe("confirmed");

    // Run 2: the model re-derives no-eval and proposes a brand new rule.
    const noSecrets = Invariant.parse({ id: "no-secrets", rule: "Never log secrets", appliesTo: ["**"], severity: "high" });
    await makePipeline(reposDir, new FakeGenerator(genArtifacts([NO_EVAL, noSecrets]))).run(input);
    const pack2 = loadPack(join(reposDir, "acme__widget", "context-pack"), "acme/widget");
    expect(pack2.manifest.version).toBe(2);
    expect(pack2.invariants.invariants.find((i) => i.id === "no-eval")?.status).toBe("confirmed"); // preserved
    expect(pack2.invariants.invariants.find((i) => i.id === "no-secrets")?.status).toBe("needs_confirmation"); // new
  });

  it("falls back to a valid minimal pack when generation fails", async () => {
    const gen = new FakeGenerator(genArtifacts([NO_EVAL]), { throws: true });
    const result = await makePipeline(reposDir, gen).run(
      OnboardingInput.parse({ repo: "acme/widget", workspaceDir: repoDir }),
    );
    expect(gen.calls).toHaveLength(1);
    expect(result.status).toBe("needs_review");
    expect(result.openQuestions[0]).toMatch(/Generation failed/);
    // Still a loadable pack (defaults + reconciled security-baseline profile).
    const pack = loadPack(join(reposDir, "acme__widget", "context-pack"), "acme/widget");
    expect(pack.profiles.profiles["security-baseline"]).toBeDefined();
    expect(pack.repoGuide).toBe(AGENTS_MD); // ingest path still worked
  });
});

describe("writePack <-> loadPack round-trip", () => {
  it("serializes the example pack and reads it back identically", async () => {
    const ex = loadPack("config/repos/_example/context-pack", "NickShtefan/kourion.fi");
    const out = await mkdtemp(join(tmpdir(), "previewer-pack-"));
    try {
      writePack(join(out, "context-pack"), ex);
      const back = loadPack(join(out, "context-pack"), "NickShtefan/kourion.fi");
      expect(back.routing.routes.length).toBe(ex.routing.routes.length);
      expect(Object.keys(back.profiles.profiles).sort()).toEqual(Object.keys(ex.profiles.profiles).sort());
      expect(back.invariants.invariants.map((i) => i.id).sort()).toEqual(ex.invariants.invariants.map((i) => i.id).sort());
      expect(back.securityBaseline.alwaysCheck).toEqual(ex.securityBaseline.alwaysCheck);
      expect(back.repoGuide.trim()).toBe(ex.repoGuide.trim());
      expect(back.subsystems.map((s) => s.name).sort()).toEqual(ex.subsystems.map((s) => s.name).sort());
      for (const a of back.manifest.artifacts) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe("reconcileRoutingProfiles", () => {
  it("guarantees a security-baseline profile and drops references to undefined profiles", () => {
    const routing = Routing.parse({
      defaults: { mandatoryProfiles: ["security-baseline", "ghost"] },
      routes: [{ name: "r", paths: ["**"], activateProfiles: ["real", "missing"] }],
    });
    const profiles = Profiles.parse({ profiles: { real: { depth: "normal" } } });
    const out = reconcileRoutingProfiles(routing, profiles);
    expect(out.profiles.profiles["security-baseline"]).toBeDefined();
    expect(out.routing.defaults.mandatoryProfiles).toEqual(["security-baseline"]);
    expect(out.routing.routes[0]!.activateProfiles).toEqual(["real"]);
    // The reconciled pair satisfies loadPack's consistency rules.
    for (const route of out.routing.routes) {
      for (const p of route.activateProfiles) expect(out.profiles.profiles[p]).toBeDefined();
    }
  });
});
