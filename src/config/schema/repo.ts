import { z } from "zod";
import { RepoId, ChangeType, SizeClass, RiskLevel } from "./common";

export const EventTriggers = z.object({
  triggers: z
    .array(z.enum(["opened", "reopened", "synchronize", "ready_for_review"]))
    .default(["opened", "reopened", "synchronize", "ready_for_review"]),
  ignoreDraft: z.boolean().default(true),
  ignorePaths: z.array(z.string()).default([]),
});
export type EventTriggers = z.infer<typeof EventTriggers>;

/** Policy override: pick a specific runner/model when change signals match. */
export const RunnerOverride = z.object({
  when: z.object({
    changeType: ChangeType.optional(),
    size: SizeClass.optional(),
    risk: RiskLevel.optional(),
  }),
  use: z.string(),
  model: z.string().optional(),
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
    })
    .default({}),
  runner: z
    .object({
      policy: z.enum(["cost_first", "quality_first", "fixed"]).default("cost_first"),
      default: z.string().default("anthropic-api"),
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
