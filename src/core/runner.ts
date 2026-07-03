import type {
  ReviewInput,
  ReviewResult,
  RunnerCapabilities,
  RunnerSelector,
  ReasoningEffort,
  OnboardingInput,
  OnboardingResult,
  Inventory,
  Routing,
  Profiles,
  Invariant,
  SecurityBaseline,
  SubsystemGuide,
  RiskMap,
} from "../config";

export interface RunLogger {
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

/** Everything the platform hands a runner that is NOT part of the review payload. */
export interface RunContext {
  workspaceDir?: string;
  budget: { maxInputTokens: number; maxOutputTokens: number };
  logger: RunLogger;
  signal: AbortSignal;
  cacheKey?: string;
  /** Grant the runner scoped shell so it can run the resolved tests (repo opted in + deps installed). */
  runTests?: boolean;
  /** Per-review model override (repo.yaml runner.model / override.model, or CLI --model). Empty = runner default. */
  modelOverride?: string;
  /** Reasoning effort for this review (repo.yaml runner.reasoningEffort / override, or CLI --reasoning). */
  reasoningEffort?: ReasoningEffort;
}

/**
 * The swappable model backend. The platform owns orchestration; a Runner only
 * turns a ReviewInput into a ReviewResult. CLI and API backends both satisfy this.
 */
export interface Runner {
  readonly id: string;
  readonly capabilities: RunnerCapabilities;
  review(input: ReviewInput, ctx: RunContext): Promise<ReviewResult>;
  /** Optional: not every backend can drive repo onboarding. */
  onboard?(input: OnboardingInput, ctx: RunContext): Promise<OnboardingResult>;
}

export interface RunnerRegistry {
  register(runner: Runner): void;
  get(id: string): Runner;
  select(sel: RunnerSelector): Runner;
  all(): RunnerCapabilities[];
}

/** An existing in-repo doc surfaced by onboarding discovery (path + type + bounded excerpt). */
export interface DiscoveredDoc {
  path: string;
  type: string;
  excerpt: string;
}

/** What the pipeline hands the generator: the cheap deterministic findings + which artifacts to author. */
export interface OnboardingGenerationRequest {
  repo: string;
  language: "ru" | "en";
  inventory: Inventory;
  discovered: DiscoveredDoc[];
  /** Artifact names the model must produce (subset of repoGuide/subsystems/routing/profiles/invariants). */
  targets: string[];
}

/** Pack artifacts a generator may return (all optional — only the requested targets are used). */
export interface GeneratedArtifacts {
  repoGuide?: string;
  subsystems?: SubsystemGuide[];
  routing?: Routing;
  profiles?: Profiles;
  /** Proposed invariants — the pipeline forces `needs_confirmation` (never auto-enforced). */
  invariants?: Invariant[];
  securityBaseline?: SecurityBaseline;
  commentTemplate?: string;
  riskMap?: RiskMap;
}

export interface PackGenerationResult {
  artifacts: GeneratedArtifacts;
  model: string;
  cost: { tokens: number; usd: number };
}

/**
 * The onboarding-time counterpart to {@link Runner}: turns the deterministic inventory +
 * discovered docs into the missing/weak pack artifacts (by reading the checkout). Kept as a
 * distinct seam because generation is artifact-shaped, whereas `Runner.onboard` is result-shaped.
 */
export interface PackGenerator {
  generate(req: OnboardingGenerationRequest, ctx: RunContext): Promise<PackGenerationResult>;
}
