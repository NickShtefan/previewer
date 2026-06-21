import { NotImplementedError } from "../core";
import type { OnboardingInput, OnboardingResult } from "../config";

/** Inventory -> discover -> assess -> generate -> persist. Implemented in M8. */
export class OnboardingPipeline {
  async run(_input: OnboardingInput): Promise<OnboardingResult> {
    throw new NotImplementedError("OnboardingPipeline.run (M8)");
  }
}
