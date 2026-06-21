import { z } from "zod";
import { RepoId, RiskLevel } from "./common";

export const Module = z.object({
  name: z.string(),
  path: z.string(),
  risk: RiskLevel.default("medium"),
});
export type Module = z.infer<typeof Module>;

export const Inventory = z.object({
  languages: z.array(z.string()).default([]),
  frameworks: z.array(z.string()).default([]),
  packageManagers: z.array(z.string()).default([]),
  ci: z.array(z.string()).default([]),
  test: z
    .object({ framework: z.string().optional(), command: z.string().optional() })
    .default({}),
  entrypoints: z.array(z.string()).default([]),
  modules: z.array(Module).default([]),
});
export type Inventory = z.infer<typeof Inventory>;

export const OnboardingInput = z.object({
  repo: RepoId,
  workspaceDir: z.string(),
  useExistingThreshold: z.number().min(0).max(1).default(0.7),
});
export type OnboardingInput = z.infer<typeof OnboardingInput>;

/** Per-artifact / per-subsystem quality scoring (use-existing vs generate). */
export const ContextAssessment = z.object({
  coverage: z.number().min(0).max(1),
  specificity: z.number().min(0).max(1),
  freshness: z.number().min(0).max(1),
  security: z.number().min(0).max(1),
  machineUsability: z.number().min(0).max(1).default(0),
});
export type ContextAssessment = z.infer<typeof ContextAssessment>;

export const ArtifactDecision = z.enum(["ingest", "augment", "generate", "needs_confirmation"]);
export type ArtifactDecision = z.infer<typeof ArtifactDecision>;

export const OnboardingResult = z.object({
  repo: RepoId,
  status: z.enum(["ready", "needs_review", "failed"]),
  inventory: Inventory,
  existingContext: z
    .object({
      found: z.array(z.object({ path: z.string(), type: z.string() })).default([]),
      assessment: ContextAssessment.optional(),
    })
    .default({ found: [] }),
  contextPack: z.object({
    ref: z.string(),
    decisions: z.record(z.string(), ArtifactDecision).default({}),
  }),
  openQuestions: z.array(z.string()).default([]),
  cost: z
    .object({
      tokens: z.number().int().nonnegative(),
      usd: z.number().nonnegative(),
    })
    .default({ tokens: 0, usd: 0 }),
});
export type OnboardingResult = z.infer<typeof OnboardingResult>;
