import type { ReasoningEffort, RunnerProfiles } from "./schema";

/**
 * Named runner PROFILES: the mechanism for switching the review "client" (runner + model +
 * reasoning effort) in one step. A profile is a `{ runner, model, reasoningEffort }` bundle stored
 * under a name in platform config (`runnerProfiles`); a repo selects the active client with one key
 * (`runner.profile: <name>`) or the `runner use <name>` CLI command. These pure helpers resolve a
 * repo's runner block to an effective client and validate profiles; they throw plain Errors (the
 * config layer must not depend on src/core to avoid an import cycle).
 */

/** The effective review client for one repo, after profile/inline resolution. */
export interface ResolvedRunnerProfile {
  /** Profile name, or INLINE_PROFILE_NAME for a repo still using the legacy inline runner block. */
  name: string;
  /** Registered runner id to run. */
  runner: string;
  /** Model override for that runner (undefined = the runner's own default). */
  model?: string;
  /** Reasoning effort for that runner. */
  reasoningEffort?: ReasoningEffort;
}

/** The subset of a repo.yaml `runner` block this module reads. RepoConfig["runner"] satisfies it. */
export interface RunnerBlockLike {
  /** Active profile name. When set, it supersedes the inline default/model/reasoningEffort below. */
  profile?: string;
  /** Legacy inline runner id (used only when no profile is set). */
  default: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

/** Sentinel name for a repo whose runner is configured inline (no named profile). */
export const INLINE_PROFILE_NAME = "(inline)";

/**
 * Resolve a repo's runner block to its effective client.
 * - `runner.profile` set  -> look it up in `profiles` (throws with the known names if unknown).
 * - no profile            -> treat the inline `default/model/reasoningEffort` as an anonymous
 *   profile (backward compatibility: existing repo.yaml keeps working unchanged).
 */
export function resolveRunnerProfile(runner: RunnerBlockLike, profiles: RunnerProfiles): ResolvedRunnerProfile {
  if (runner.profile !== undefined) {
    const p = profiles[runner.profile];
    if (!p) {
      const known = Object.keys(profiles).sort().join(", ") || "(none defined)";
      throw new Error(`Unknown runner profile "${runner.profile}". Defined profiles: ${known}.`);
    }
    return { name: runner.profile, runner: p.runner, model: p.model, reasoningEffort: p.reasoningEffort };
  }
  return {
    name: INLINE_PROFILE_NAME,
    runner: runner.default,
    model: runner.model,
    reasoningEffort: runner.reasoningEffort,
  };
}

/** Profiles whose `runner` is not a registered runner id. Empty array = all valid. */
export function invalidProfileRunners(
  profiles: RunnerProfiles,
  registeredRunnerIds: readonly string[],
): Array<{ name: string; runner: string }> {
  const ids = new Set(registeredRunnerIds);
  const bad: Array<{ name: string; runner: string }> = [];
  for (const [name, p] of Object.entries(profiles)) {
    if (!ids.has(p.runner)) bad.push({ name, runner: p.runner });
  }
  return bad;
}

/** Throw if any profile targets an unregistered runner id (called at startup/compose time). */
export function assertProfilesValid(profiles: RunnerProfiles, registeredRunnerIds: readonly string[]): void {
  const bad = invalidProfileRunners(profiles, registeredRunnerIds);
  if (bad.length > 0) {
    const detail = bad.map((b) => `"${b.name}" -> unknown runner "${b.runner}"`).join("; ");
    const known = [...registeredRunnerIds].sort().join(", ");
    throw new Error(`Invalid runner profile(s): ${detail}. Registered runners: ${known}.`);
  }
}
