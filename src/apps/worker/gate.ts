import type { GatingDecision, GatingInput } from "../../core";
import { globMatch } from "../../context";

/** Cheap pre-model gate: skip no-op/ignored-only changes before spending a runner. */
export function gate(input: GatingInput): GatingDecision {
  if (input.changedFiles.length === 0) {
    return { action: "skip", reason: "no changed files" };
  }
  const relevant = input.changedFiles.filter(
    (f) => !input.ignorePaths.some((g) => globMatch(g, f.path)),
  );
  if (relevant.length === 0) {
    return { action: "skip", reason: "only ignored paths changed" };
  }
  return { action: "review", reason: `${relevant.length} reviewable file(s)` };
}
