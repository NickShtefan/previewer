import type {
  ReviewInput,
  ReviewResult,
  RunnerCapabilities,
  RunnerSelector,
  OnboardingInput,
  OnboardingResult,
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
