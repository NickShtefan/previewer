import { z } from "zod";
import { ChangeType, SizeClass, RiskLevel } from "./common";

/**
 * Declares what a runner backend can do, so the policy engine can select by
 * cost / quality / change-type. CLI runners are agentic and need a workspace;
 * API runners are stateless and need the platform to assemble context.
 */
export const RunnerCapabilities = z.object({
  id: z.string(),
  kind: z.enum(["cli", "api"]),
  provider: z.string(),
  agentic: z.boolean(),
  needsWorkspace: z.boolean(),
  canRunTests: z.boolean().default(false),
  structuredOutput: z.enum(["native_json", "via_prompt", "tool_call"]),
  contextWindow: z.number().int().positive(),
  cost: z.object({
    inputPerMtok: z.number().nonnegative(),
    outputPerMtok: z.number().nonnegative(),
    fixedOverheadUsd: z.number().nonnegative().default(0),
  }),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  maxParallel: z.number().int().positive().default(1),
  auth: z.object({
    type: z.enum(["api_key", "cli_session"]),
    env: z.string().optional(),
  }),
});
export type RunnerCapabilities = z.infer<typeof RunnerCapabilities>;

/** Resolved selection request handed to the registry. */
export const RunnerSelector = z.object({
  policy: z.enum(["cost_first", "quality_first", "fixed"]),
  preferred: z.string(),
  changeType: ChangeType.optional(),
  size: SizeClass.optional(),
  risk: RiskLevel.optional(),
});
export type RunnerSelector = z.infer<typeof RunnerSelector>;
