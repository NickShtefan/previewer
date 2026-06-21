import type { Runner, RunContext } from "../../core";
import { NotImplementedError } from "../../core";
import type { ReviewInput, ReviewResult, RunnerCapabilities } from "../../config";

/**
 * Optional API alternative (not the default). The user prefers the subscription
 * CLI runner; this stays available for cost/throughput routing if a key is set.
 */
export class AnthropicApiRunner implements Runner {
  readonly id = "anthropic-api";
  readonly capabilities: RunnerCapabilities = {
    id: "anthropic-api",
    kind: "api",
    provider: "anthropic",
    agentic: false,
    needsWorkspace: false,
    canRunTests: false,
    structuredOutput: "native_json",
    contextWindow: 200000,
    cost: { inputPerMtok: 3, outputPerMtok: 15, fixedOverheadUsd: 0 },
    strengths: ["predictable", "structured_output", "small_diff"],
    weaknesses: ["no_autonomous_exploration"],
    maxParallel: 4,
    auth: { type: "api_key", env: "ANTHROPIC_API_KEY" },
  };

  async review(_input: ReviewInput, _ctx: RunContext): Promise<ReviewResult> {
    throw new NotImplementedError("AnthropicApiRunner.review — optional API alternative (not the default runner)");
  }
}
