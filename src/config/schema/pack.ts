import { z } from "zod";
import { RepoId, Glob, RiskLevel, Depth, Severity } from "./common";

/** Where an artifact came from + how much to trust it (drives use-existing vs generate). */
export const Provenance = z.object({
  source: z.enum(["ingested", "augmented", "generated"]),
  from: z.string().optional(),
  model: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  approvedBy: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export const PackManifest = z.object({
  version: z.number().int().positive(),
  generatedAt: z.string(),
  provenance: z.record(z.string(), Provenance).default({}),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string() })).default([]),
});
export type PackManifest = z.infer<typeof PackManifest>;

/**
 * Additive routing: a PR activates the UNION of profiles from every matched route
 * (plus `defaults.mandatoryProfiles`). Profiles are defined in profiles.yaml; routes
 * only reference them by name. Modeled on the kourion.fi reference reviewer layer.
 */
export const RoutingDefaults = z.object({
  publishMode: z.string().default("single_top_level_comment"),
  formalReview: z.boolean().default(false),
  dedupeKey: z.string().default("repo_pr_head_sha"),
  mandatoryProfiles: z.array(z.string()).default(["security-baseline"]),
  requiredContext: z.array(z.string()).default(["AGENTS.md"]),
});
export type RoutingDefaults = z.infer<typeof RoutingDefaults>;

export const Route = z.object({
  name: z.string(),
  paths: z.array(Glob).default([]),
  activateProfiles: z.array(z.string()).default([]),
});
export type Route = z.infer<typeof Route>;

export const Routing = z.object({
  version: z.number().int().positive().default(1),
  defaults: RoutingDefaults.default({}),
  routes: z.array(Route).default([]),
  /** Cross-cutting heuristics, e.g. "schema change without migration -> finding". */
  notes: z.array(z.string()).default([]),
});
export type Routing = z.infer<typeof Routing>;

export const ReviewProfile = z.object({
  depth: Depth.default("normal"),
  focus: z.array(z.string()).default([]),
  /** Doc paths this profile pulls into context when active. */
  docs: z.array(z.string()).default([]),
  /** Test commands to run when this profile is active (gated by runTests). */
  tests: z.array(z.string()).default([]),
  runTests: z.boolean().default(false),
});
export type ReviewProfile = z.infer<typeof ReviewProfile>;
export const Profiles = z.object({ profiles: z.record(z.string(), ReviewProfile) });
export type Profiles = z.infer<typeof Profiles>;

export const Invariant = z.object({
  id: z.string(),
  rule: z.string(),
  appliesTo: z.array(Glob).default(["**"]),
  status: z.enum(["confirmed", "needs_confirmation", "rejected"]).default("needs_confirmation"),
  /** Finding severity if this invariant is violated (for ordering findings). */
  severity: Severity.optional(),
  /** Concrete questions a reviewer asks on PRs touching this invariant. */
  reviewerQuestions: z.array(z.string()).default([]),
  /** Optional long-form detail (why it exists, known bug class). */
  body: z.string().default(""),
});
export type Invariant = z.infer<typeof Invariant>;
export const Invariants = z.object({ invariants: z.array(Invariant).default([]) });
export type Invariants = z.infer<typeof Invariants>;

/** Mandatory security/privacy/risk lens — applied to every repo regardless of domain. */
export const SecurityBaseline = z.object({
  alwaysCheck: z
    .array(z.string())
    .default([
      "data_leaks",
      "unauthorized_access",
      "dangerous_external_calls",
      "auth_session_regressions",
      "privacy_boundary_leaks",
      "insecure_reads_writes",
      "analytics_data_exfiltration",
      "supply_chain_secret_exposure",
    ]),
  severityFloor: Severity.default("medium"),
  extra: z.array(z.string()).default([]),
});
export type SecurityBaseline = z.infer<typeof SecurityBaseline>;

export const SubsystemGuide = z.object({
  name: z.string(),
  path: z.string(),
  summary: z.string(),
  risk: RiskLevel.default("medium"),
  body: z.string().default(""),
});
export type SubsystemGuide = z.infer<typeof SubsystemGuide>;

export const RiskEntry = z.object({
  area: z.string(),
  risk: RiskLevel,
  tests: z.array(z.string()).default([]),
});
export type RiskEntry = z.infer<typeof RiskEntry>;
export const RiskMap = z.object({ entries: z.array(RiskEntry).default([]) });
export type RiskMap = z.infer<typeof RiskMap>;

/** The fully assembled, in-memory context pack (loaded from the on-disk artifacts). */
export const ContextPack = z.object({
  repo: RepoId,
  manifest: PackManifest,
  repoGuide: z.string().default(""),
  subsystems: z.array(SubsystemGuide).default([]),
  routing: Routing,
  profiles: Profiles,
  invariants: Invariants,
  securityBaseline: SecurityBaseline,
  commentTemplate: z.string().default(""),
  riskMap: RiskMap.default({ entries: [] }),
});
export type ContextPack = z.infer<typeof ContextPack>;
