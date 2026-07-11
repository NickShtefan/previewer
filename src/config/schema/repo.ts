import { z } from "zod";
import { RepoId, ChangeType, SizeClass, RiskLevel, ReasoningEffort } from "./common";

export const EventTriggers = z.object({
  triggers: z
    .array(z.enum(["opened", "reopened", "synchronize", "ready_for_review"]))
    .default(["opened", "reopened", "synchronize", "ready_for_review"]),
  ignoreDraft: z.boolean().default(true),
  ignorePaths: z.array(z.string()).default([]),
});
export type EventTriggers = z.infer<typeof EventTriggers>;

/** Policy override: pick a specific runner/model/effort when change signals match. */
export const RunnerOverride = z.object({
  when: z.object({
    changeType: ChangeType.optional(),
    size: SizeClass.optional(),
    risk: RiskLevel.optional(),
  }),
  use: z.string(),
  model: z.string().optional(),
  reasoningEffort: ReasoningEffort.optional(),
});
export type RunnerOverride = z.infer<typeof RunnerOverride>;

/** Per-repo configuration (`config/repos/<owner>__<name>/repo.yaml`). */
export const RepoConfig = z.object({
  repo: z.object({
    id: RepoId,
    enabled: z.boolean().default(true),
    defaultBranch: z.string().default("main"),
  }),
  events: EventTriggers.default({}),
  review: z
    .object({
      defaultProfile: z.string().default("standard"),
      incremental: z.boolean().default(true),
      depthPolicy: z.enum(["fixed", "size_aware", "risk_aware"]).default("size_aware"),
      maxTokensPerRun: z.number().int().positive().default(120000),
      /**
       * Master opt-in for running an active profile's `tests` in the worktree (installs deps +
       * grants the runner scoped shell). Off by default: enabling it lets the reviewer execute
       * this repo's test/install scripts on the runner machine.
       */
      runTests: z.boolean().default(false),
    })
    .default({}),
  runner: z
    .object({
      policy: z.enum(["cost_first", "quality_first", "fixed"]).default("cost_first"),
      /**
       * Active runner profile (name in platform `runnerProfiles`). When set it supplies
       * runner+model+reasoningEffort and SUPERSEDES the inline default/model/reasoningEffort below.
       * Omit to keep the legacy inline behavior. Switch with: `npm run cli -- runner use <name>`.
       */
      profile: z.string().optional(),
      default: z.string().default("anthropic-api"),
      /** Model for the default runner (e.g. "claude-opus-4-8", "gpt-5-codex"). Empty = runner's own default. */
      model: z.string().optional(),
      /** Reasoning effort for the default runner. Empty = runner/model default. */
      reasoningEffort: ReasoningEffort.optional(),
      overrides: z.array(RunnerOverride).default([]),
    })
    .default({}),
  publish: z
    .object({
      mode: z.literal("single_top_level_comment").default("single_top_level_comment"),
      formalReview: z.literal(false).default(false),
      includeHeadSha: z.boolean().default(true),
      upsert: z.literal("per_head_sha").default("per_head_sha"),
    })
    .default({}),
  context: z
    .object({
      source: z.enum(["platform", "repo", "hybrid"]).default("hybrid"),
      packRef: z.string().default("context-pack@latest"),
    })
    .default({}),
  security: z
    .object({
      baseline: z.string().default("default"),
      extra: z.array(z.string()).default([]),
    })
    .default({}),
});
export type RepoConfig = z.infer<typeof RepoConfig>;
