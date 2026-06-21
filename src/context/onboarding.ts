import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { PackGenerator, RunContext, RunLogger, GeneratedArtifacts } from "../core";
import {
  OnboardingInput,
  OnboardingResult,
  ContextPack,
  Routing,
  Profiles,
  SecurityBaseline,
  Invariant,
  Invariants,
  type SubsystemGuide,
  type RiskMap,
  type Inventory,
  type ArtifactDecision,
  type Provenance as ProvenanceT,
  loadRepoConfig,
  type RepoConfig,
} from "../config";
import { buildInventory } from "./inventory";
import { discoverContext, subsystemNameFromAgents } from "./discover";
import { assessArtifacts, planNeedsModel, type ArtifactPlan } from "./assess";
import { loadPack, writePack, parseSubsystemGuide } from "./pack";
import { readMaybe } from "./fs-scan";

/** A generic comment template used when a repo has none to ingest (provenance: generated). */
const DEFAULT_COMMENT_TEMPLATE = `## Automated review

Head SHA: \`{head_sha}\`
Profiles: {active_profiles}

Tests run:
{tests_run}

Tests not run:
{tests_not_run}

Findings:
{findings}

Residual risk:
{residual_risk}

<!-- ai-review:{repo}#{pr}@{head_sha} -->
`;

export interface OnboardingDeps {
  generator: PackGenerator;
  /** Platform repos root (`config/repos`) — where the pack + repo.yaml are persisted. */
  reposDir: string;
  language: "ru" | "en";
  logger: RunLogger;
  /** Injectable clock for deterministic `generatedAt` in tests. */
  now?: () => Date;
}

export interface OnboardingRunOptions {
  /** Persist the pack + repo.yaml to disk. Default true; `--dry-run` passes false. */
  persist?: boolean;
  /** Approve generated invariants in this run (sets status confirmed + approvedBy). */
  confirmInvariants?: boolean;
  approvedBy?: string;
}

const provFor = (decision: ArtifactDecision): ProvenanceT["source"] =>
  decision === "ingest" ? "ingested" : decision === "augment" ? "augmented" : "generated";

/** Inventory -> discover -> assess -> decide -> generate -> human-gate -> persist (M8). */
export class OnboardingPipeline {
  constructor(private readonly deps: OnboardingDeps) {}

  async run(input: OnboardingInput, opts: OnboardingRunOptions = {}): Promise<OnboardingResult> {
    const persist = opts.persist ?? true;
    const now = this.deps.now ?? ((): Date => new Date());
    const repoDir = input.workspaceDir;
    const destDir = join(this.deps.reposDir, input.repo.replace("/", "__"), "context-pack");

    // 1-3: deterministic, model-free.
    const inventory = buildInventory(repoDir);
    const discovery = discoverContext(repoDir);
    const { plans, overall } = assessArtifacts(repoDir, discovery, input.useExistingThreshold);
    const planFor = (name: string): ArtifactPlan => plans.find((p) => p.artifact === name)!;

    const previous = this.loadPrevious(destDir, input.repo);
    const repoConfig = this.tryLoadRepoConfig(input.repo);

    // 6: generate only the artifacts that need the model (ingest paths are deterministic).
    const targets = plans.filter(planNeedsModel).map((p) => p.artifact);
    let gen: GeneratedArtifacts = {};
    let cost = { tokens: 0, usd: 0 };
    let model: string | undefined;
    let genFailed = false;
    if (targets.length) {
      try {
        const res = await this.deps.generator.generate(
          { repo: input.repo, language: this.deps.language, inventory, discovered: discovery.found, targets },
          this.runCtx(repoDir),
        );
        gen = res.artifacts;
        cost = res.cost;
        model = res.model;
        this.deps.logger.info(`onboarding generated ${targets.join(", ")} (${cost.tokens} tok, $${cost.usd})`);
      } catch (e) {
        genFailed = true;
        this.deps.logger.error(`onboarding generation failed: ${(e as Error).message}`);
      }
    }

    // 7: assemble each artifact + provenance.
    const provenance: Record<string, ProvenanceT> = {};
    const repoGuide = this.buildRepoGuide(repoDir, planFor("repoGuide"), gen, provenance, model);
    const subsystems = this.buildSubsystems(repoDir, planFor("subsystems"), gen, inventory, provenance, model);
    let routing = this.buildRouting(repoDir, planFor("routing"), gen, previous?.routing, provenance, model);
    let profiles = this.buildProfiles(repoDir, planFor("profiles"), gen, previous?.profiles, provenance, model);
    ({ routing, profiles } = reconcileRoutingProfiles(routing, profiles));
    const invariants = this.buildInvariants(repoDir, planFor("invariants"), gen, previous, opts, provenance, model);
    const securityBaseline = this.buildSecurityBaseline(repoDir, planFor("securityBaseline"), repoConfig, provenance);
    const commentTemplate = this.buildCommentTemplate(repoDir, planFor("commentTemplate"), provenance);
    const riskMap: RiskMap = gen.riskMap ?? previous?.riskMap ?? { entries: [] };
    if (gen.riskMap?.entries.length) provenance.riskMap = { source: "generated", model, confidence: 0.5 };

    const version = previous ? previous.manifest.version + 1 : 1;
    const pack = ContextPack.parse({
      repo: input.repo,
      manifest: { version, generatedAt: now().toISOString(), provenance, artifacts: [] },
      repoGuide,
      subsystems,
      routing,
      profiles,
      invariants: { invariants },
      securityBaseline,
      commentTemplate,
      riskMap,
    });

    // 8: persist (writePack recomputes manifest sha256s).
    if (persist) {
      writePack(destDir, pack);
      this.ensureRepoYaml(input.repo, repoConfig, version);
      this.deps.logger.info(`wrote context-pack@v${version} for ${input.repo} -> ${destDir}`);
    }

    const decisions: Record<string, ArtifactDecision> = {};
    for (const p of plans) decisions[p.artifact] = p.decision;

    const needsConfirm = invariants.filter((i) => i.status === "needs_confirmation");
    const openQuestions: string[] = needsConfirm.map(
      (i) => `Confirm invariant "${i.id}" [${i.severity ?? "?"}]: ${i.rule}`,
    );
    if (genFailed) {
      openQuestions.unshift("Generation failed — a minimal pack was written. Re-run onboarding (check `claude` auth).");
    }
    const status: OnboardingResult["status"] = genFailed || needsConfirm.length ? "needs_review" : "ready";

    return OnboardingResult.parse({
      repo: input.repo,
      status,
      inventory,
      existingContext: {
        found: discovery.found.map((d) => ({ path: d.path, type: d.type })),
        assessment: overall,
      },
      contextPack: { ref: `context-pack@v${version}`, decisions },
      openQuestions,
      cost: { tokens: cost.tokens, usd: cost.usd },
    });
  }

  // ---- stage helpers -------------------------------------------------------

  private runCtx(repoDir: string): RunContext {
    return {
      workspaceDir: repoDir,
      budget: { maxInputTokens: 120_000, maxOutputTokens: 16_000 },
      logger: this.deps.logger,
      signal: new AbortController().signal,
    };
  }

  private loadPrevious(destDir: string, repo: string): ContextPack | null {
    if (!existsSync(join(destDir, "manifest.yaml"))) return null;
    try {
      return loadPack(destDir, repo);
    } catch (e) {
      this.deps.logger.warn(`previous pack at ${destDir} did not load; treating as fresh: ${(e as Error).message}`);
      return null;
    }
  }

  private tryLoadRepoConfig(repo: string): RepoConfig | null {
    const p = join(this.deps.reposDir, repo.replace("/", "__"), "repo.yaml");
    if (!existsSync(p)) return null;
    try {
      return loadRepoConfig(p);
    } catch {
      return null;
    }
  }

  private buildRepoGuide(
    repoDir: string,
    plan: ArtifactPlan,
    gen: GeneratedArtifacts,
    prov: Record<string, ProvenanceT>,
    model?: string,
  ): string {
    if (plan.decision === "ingest" && plan.source) {
      const content = readMaybe(repoDir, plan.source.path) ?? "";
      if (content) {
        prov.repoGuide = { source: "ingested", from: plan.source.path };
        return content;
      }
    }
    if (gen.repoGuide) {
      prov.repoGuide = { source: provFor(plan.decision), from: plan.source?.path, model, confidence: 0.6 };
      return gen.repoGuide;
    }
    return "";
  }

  private buildSubsystems(
    repoDir: string,
    plan: ArtifactPlan,
    gen: GeneratedArtifacts,
    inventory: Inventory,
    prov: Record<string, ProvenanceT>,
    model?: string,
  ): SubsystemGuide[] {
    const riskOfPath = (path: string): SubsystemGuide["risk"] => {
      const top = path.split("/")[0] ?? path;
      return inventory.modules.find((m) => m.path === top)?.risk ?? "medium";
    };

    if (plan.decision === "ingest" && plan.sources?.length) {
      const out: SubsystemGuide[] = [];
      for (const src of plan.sources) {
        const content = readMaybe(repoDir, src.path);
        if (!content) continue;
        if (src.type === "agents-nested") {
          const { name, path } = subsystemNameFromAgents(src.path);
          out.push({ name, path, summary: firstProse(content), risk: riskOfPath(path), body: content });
        } else {
          const name = (src.path.split("/").pop() ?? "subsystem").replace(/\.md$/, "");
          out.push(parseSubsystemGuide(name, content));
        }
      }
      if (out.length) {
        prov.subsystems = { source: "ingested", from: plan.sources.map((s) => s.path).join(", ") };
        return out;
      }
    }

    if (gen.subsystems?.length) {
      prov.subsystems = { source: provFor(plan.decision), model, confidence: 0.5 };
      return gen.subsystems;
    }

    // Fallback: derive thin stubs from the inventory's modules (no model).
    const stubs = inventory.modules.map((m) => ({
      name: m.name,
      path: m.path,
      summary: `Module ${m.name} (risk ${m.risk}).`,
      risk: m.risk,
      body: "",
    }));
    if (stubs.length) prov.subsystems = { source: "generated", from: "inventory modules", confidence: 0.2 };
    return stubs;
  }

  private buildRouting(
    repoDir: string,
    plan: ArtifactPlan,
    gen: GeneratedArtifacts,
    previous: Routing | undefined,
    prov: Record<string, ProvenanceT>,
    model?: string,
  ): Routing {
    if (plan.decision === "ingest" && plan.source) {
      const parsed = readYaml(repoDir, plan.source.path, Routing);
      if (parsed) {
        prov.routing = { source: "ingested", from: plan.source.path };
        return parsed;
      }
    }
    if (gen.routing) {
      prov.routing = { source: provFor(plan.decision), from: plan.source?.path, model, confidence: 0.5 };
      return gen.routing;
    }
    if (previous) {
      prov.routing = { source: "ingested", from: "previous pack" };
      return previous;
    }
    prov.routing = { source: "generated", from: "default", confidence: 0.2 };
    return Routing.parse({});
  }

  private buildProfiles(
    repoDir: string,
    plan: ArtifactPlan,
    gen: GeneratedArtifacts,
    previous: Profiles | undefined,
    prov: Record<string, ProvenanceT>,
    model?: string,
  ): Profiles {
    if (plan.decision === "ingest" && plan.source) {
      const parsed = readYaml(repoDir, plan.source.path, Profiles);
      if (parsed) {
        prov.profiles = { source: "ingested", from: plan.source.path };
        return parsed;
      }
    }
    if (gen.profiles) {
      prov.profiles = { source: provFor(plan.decision), from: plan.source?.path, model, confidence: 0.5 };
      return gen.profiles;
    }
    if (previous) {
      prov.profiles = { source: "ingested", from: "previous pack" };
      return previous;
    }
    prov.profiles = { source: "generated", from: "default", confidence: 0.2 };
    return Profiles.parse({ profiles: {} });
  }

  /** Human-confirm gate: generated invariants are needs_confirmation; previously-confirmed ones are preserved. */
  private buildInvariants(
    repoDir: string,
    plan: ArtifactPlan,
    gen: GeneratedArtifacts,
    previous: ContextPack | null,
    opts: OnboardingRunOptions,
    prov: Record<string, ProvenanceT>,
    model?: string,
  ): Invariant[] {
    const approvedBy = opts.confirmInvariants ? opts.approvedBy ?? "cli-user" : undefined;

    if (plan.decision === "ingest" && plan.source) {
      const parsed = readYaml(repoDir, plan.source.path, Invariants);
      if (parsed) {
        prov.invariants = { source: "ingested", from: plan.source.path, approvedBy };
        return parsed.invariants.map((i) =>
          opts.confirmInvariants && i.status === "needs_confirmation" ? { ...i, status: "confirmed" } : i,
        );
      }
    }

    const prevConfirmed = previous?.invariants.invariants.filter((i) => i.status === "confirmed") ?? [];
    const prevById = new Map(prevConfirmed.map((i) => [i.id, i]));
    const generated = gen.invariants ?? [];

    if (!generated.length && prevConfirmed.length) {
      // Generation produced nothing (e.g. failure) — preserve the human-approved rules.
      prov.invariants = { source: "ingested", from: "previous pack (confirmed)", approvedBy };
      return prevConfirmed;
    }

    const seen = new Set<string>();
    const merged: Invariant[] = generated.map((i) => {
      seen.add(i.id);
      const status = prevById.has(i.id) || opts.confirmInvariants ? "confirmed" : "needs_confirmation";
      return Invariant.parse({ ...i, status });
    });
    for (const i of prevConfirmed) if (!seen.has(i.id)) merged.push(i);

    if (merged.length) {
      const from = plan.sources?.map((s) => s.path).join(", ");
      prov.invariants = { source: provFor(plan.decision), from, model, confidence: 0.4, approvedBy };
    }
    return merged;
  }

  private buildSecurityBaseline(
    repoDir: string,
    plan: ArtifactPlan,
    repoConfig: RepoConfig | null,
    prov: Record<string, ProvenanceT>,
  ): SecurityBaseline {
    if (plan.decision === "ingest" && plan.source) {
      const parsed = readYaml(repoDir, plan.source.path, SecurityBaseline);
      if (parsed) {
        prov.securityBaseline = { source: "ingested", from: plan.source.path };
        return parsed;
      }
    }
    const extra = repoConfig?.security.extra ?? [];
    const from = plan.source ? `platform default + ${plan.source.path}` : "platform default + repo.security.extra";
    prov.securityBaseline = { source: "generated", from, confidence: 0.9 };
    return SecurityBaseline.parse({ extra });
  }

  private buildCommentTemplate(
    repoDir: string,
    plan: ArtifactPlan,
    prov: Record<string, ProvenanceT>,
  ): string {
    if (plan.decision === "ingest" && plan.source) {
      const content = readMaybe(repoDir, plan.source.path);
      if (content) {
        prov.commentTemplate = { source: "ingested", from: plan.source.path };
        return content;
      }
    }
    prov.commentTemplate = { source: "generated", from: "platform default" };
    return DEFAULT_COMMENT_TEMPLATE;
  }

  private ensureRepoYaml(repo: string, existing: RepoConfig | null, version: number): void {
    const dir = join(this.deps.reposDir, repo.replace("/", "__"));
    const p = join(dir, "repo.yaml");
    if (existsSync(p)) return;
    mkdirSync(dir, { recursive: true });
    const minimal = {
      repo: { id: repo, enabled: true, defaultBranch: existing?.repo.defaultBranch ?? "main" },
      review: { defaultProfile: "security-baseline" },
      context: { source: "hybrid", packRef: `context-pack@v${version}` },
    };
    writeFileSync(p, `# Generated by onboarding (M8). Edit freely.\n${stringifyYaml(minimal)}`);
  }
}

// ---- module-private utilities ----------------------------------------------

/** First non-heading, non-meta prose line of a doc (subsystem summary). */
function firstProse(content: string): string {
  return (
    content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("**") && !l.startsWith(">") && !l.startsWith("-")) ??
    ""
  );
}

/** Parse a repo YAML file against a zod schema; undefined if missing or invalid. */
function readYaml<T>(repoDir: string, rel: string, schema: { parse(v: unknown): T }): T | undefined {
  const content = readMaybe(repoDir, rel);
  if (!content) return undefined;
  try {
    return schema.parse(parseYaml(content));
  } catch {
    return undefined;
  }
}

/**
 * Make routing+profiles satisfy loadPack's consistency rules: a `security-baseline` profile
 * must exist, mandatory + referenced profiles must be defined. Defensive against model drift.
 */
export function reconcileRoutingProfiles(routing: Routing, profiles: Profiles): { routing: Routing; profiles: Profiles } {
  const defined = { ...profiles.profiles };
  if (!defined["security-baseline"]) {
    defined["security-baseline"] = {
      depth: "normal",
      focus: ["data_leak", "authz", "session"],
      docs: ["AGENTS.md"],
      tests: [],
      runTests: false,
    };
  }
  const has = (name: string): boolean => Boolean(defined[name]);

  const mandatory = routing.defaults.mandatoryProfiles.filter(has);
  if (!mandatory.includes("security-baseline")) mandatory.unshift("security-baseline");

  const routes = routing.routes.map((r) => ({ ...r, activateProfiles: r.activateProfiles.filter(has) }));

  return {
    routing: Routing.parse({
      ...routing,
      defaults: { ...routing.defaults, mandatoryProfiles: mandatory },
      routes,
    }),
    profiles: Profiles.parse({ profiles: defined }),
  };
}
