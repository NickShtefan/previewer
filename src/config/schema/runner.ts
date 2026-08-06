import { z } from "zod";
import { ChangeType, SizeClass, RiskLevel, ReasoningEffort } from "./common";

/**
 * Declares what a runner backend can do, so the policy engine can select by
 * cost / quality / change-type. CLI runners are agentic and need a workspace;
 * API runners are stateless and need the platform to assemble context.
 */
export const RunnerCapabilities = z.object({
  id: z.string(),
  /**
   * False for a registered-but-unimplemented backend (a stub kept for routing/discovery).
   * Config validation rejects a repo that resolves to one: a stub is indistinguishable from a
   * real runner by id alone, so without this flag a config naming it passes every startup check
   * and only fails once the review has already been claimed — with no run row and no trace.
   *
   * Every runner must state it. The `.default(true)` applies only to a PARSED capabilities
   * object; in-tree runners declare `capabilities` as a typed literal (the zod OUTPUT type),
   * where the field is required and `tsc` catches a new runner that forgets it.
   */
  implemented: z.boolean().default(true),
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

/**
 * A named runner PROFILE: bundles a runner id with its model/effort semantics under one name.
 * Switching the active review client is then a single key (`runner.profile: <name>`) or one CLI
 * command, instead of hand-editing `runner.default` + each runner's `model`/`reasoningEffort`.
 * Room for future knobs (add fields here + thread them through resolveRunnerProfile / RunContext).
 */
export const RunnerProfile = z.object({
  /** Registered runner id this profile targets (e.g. "codex-cli", "claude-cli"). */
  runner: z.string(),
  /** Model for that runner (codex `-m`, claude `--model`). Empty = the runner's own default. */
  model: z.string().optional(),
  /** Reasoning effort for that runner (codex `model_reasoning_effort`, claude `--effort`). */
  reasoningEffort: ReasoningEffort.optional(),
  /** Human note shown by `runner list`. */
  description: z.string().optional(),
});
export type RunnerProfile = z.infer<typeof RunnerProfile>;

/** Map of profile name -> profile. Lives in platform config (`runnerProfiles`). */
export const RunnerProfiles = z.record(z.string(), RunnerProfile);
export type RunnerProfiles = z.infer<typeof RunnerProfiles>;

/**
 * Built-in starter profiles. Used as the platform-config default so profiles always exist even when
 * `config/platform.yaml` omits `runnerProfiles`.
 *
 * `runnerProfiles` in platform.yaml REPLACES this map wholesale (a zod `.default()` applies only when
 * the key is absent) — it does not merge. So an operator who wants one extra client has to restate
 * every built-in alongside it, and that hand-copy then drifts from this file silently. A profile that
 * is a normal choice for everyone belongs HERE, not in an operator's config.
 * Adding a new client = add an entry here (or in platform.yaml) whose `runner` is a registered id.
 */
export const DEFAULT_RUNNER_PROFILES: RunnerProfiles = {
  "codex-gpt56-max": {
    runner: "codex-cli",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    description: "codex-cli on the GPT-5.6 Sol flagship at max reasoning (ChatGPT subscription).",
  },
  "opus5-max": {
    runner: "claude-cli",
    model: "claude-opus-5",
    reasoningEffort: "max",
    description: "claude-cli on Opus 5 at max effort (Claude subscription) - the deepest Claude tier.",
  },
  "fable-max": {
    runner: "claude-cli",
    model: "claude-fable-5",
    reasoningEffort: "max",
    description: "claude-cli on Fable 5 at max effort (Claude subscription, no codex quota).",
  },
  "claude-sonnet": {
    runner: "claude-cli",
    model: "claude-sonnet-4-6",
    reasoningEffort: "high",
    description: "claude-cli on Sonnet 4.6 at high effort - cheaper/faster Claude tier.",
  },
};

/** Resolved selection request handed to the registry. */
export const RunnerSelector = z.object({
  policy: z.enum(["cost_first", "quality_first", "fixed"]),
  preferred: z.string(),
  changeType: ChangeType.optional(),
  size: SizeClass.optional(),
  risk: RiskLevel.optional(),
  /** Resolved model for the selected runner (repo.yaml runner.model / matching override.model). */
  model: z.string().optional(),
  /** Resolved reasoning effort for the selected runner. */
  reasoningEffort: ReasoningEffort.optional(),
});
export type RunnerSelector = z.infer<typeof RunnerSelector>;
