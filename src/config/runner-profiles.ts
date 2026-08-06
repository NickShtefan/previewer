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

/** A repo whose runner block cannot be resolved to a runnable client. */
export interface RepoRunnerProblem {
  repo: string;
  /** Operator-facing explanation, already naming the offending value and the valid ones. */
  message: string;
}

/** The slice of a RepoConfig this check reads. `RepoConfig` satisfies it structurally. */
export interface RepoConfigLike {
  repo: { id: string };
  runner: RunnerBlockLike & { overrides?: Array<{ use: string }> };
}

/**
 * What the check needs to know about a registered runner. `RunnerCapabilities` satisfies it.
 *
 * The check takes capabilities rather than bare ids because a stub is indistinguishable from a
 * real runner by id alone — and "resolves to a registered id" is exactly the test a stub passes.
 */
export interface RegisteredRunnerLike {
  id: string;
  /** Absent is treated as implemented; only a stub declares `false`. */
  implemented?: boolean;
}

/** Why this runner id cannot serve a review, or null if it can. */
function runnerUnusable(id: string, runners: readonly RegisteredRunnerLike[]): string | null {
  const known = runners.map((r) => r.id).sort().join(", ") || "(none registered)";
  const found = runners.find((r) => r.id === id);
  if (!found) return `unknown runner "${id}". Registered runners: ${known}.`;
  if (found.implemented === false) {
    return `runner "${id}" is a stub with no implementation — it would fail the review after claiming it.`;
  }
  return null;
}

/**
 * Why a repo's runner block is not runnable, or null when it is.
 *
 * Resolution used to blow up deep inside the review pipeline — AFTER the review was claimed —
 * so a one-word typo in `platform.yaml` turned into a stranded claim and a lost review instead
 * of a startup error. Checking it as a value lets the platform report it at startup, show it on
 * the dashboard, and fail the review before it claims anything.
 */
export function runnerConfigProblem(
  cfg: RepoConfigLike,
  profiles: RunnerProfiles,
  runners: readonly RegisteredRunnerLike[],
): string | null {
  let active: ResolvedRunnerProfile;
  try {
    active = resolveRunnerProfile(cfg.runner, profiles);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }

  // The dangerous case is not a typo — it is a repo.yaml that carries ONLY `profile:` and then
  // loses that line: resolution silently falls through to the `runner.default` zod fallback,
  // which is a value no one wrote in the file. If that fallback names a stub, every id-based
  // check passes and the review dies after claiming, with no run row and no dashboard signal.
  const unusable = runnerUnusable(active.runner, runners);
  if (unusable) {
    const via = active.name === INLINE_PROFILE_NAME ? "runner.default" : `profile "${active.name}"`;
    return `${via} selects ${unusable}`;
  }
  // Overrides carry their own inline runner id and win when their `when` matches, so a bad one
  // is a latent failure that only fires on a matching diff — catch it up front, not on that PR.
  for (const ov of cfg.runner.overrides ?? []) {
    const bad = runnerUnusable(ov.use, runners);
    if (bad) return `runner override selects ${bad}`;
  }
  return null;
}

/** Run {@link runnerConfigProblem} across repos; empty array = every repo is runnable. */
export function repoRunnerProblems(
  repos: readonly RepoConfigLike[],
  profiles: RunnerProfiles,
  runners: readonly RegisteredRunnerLike[],
): RepoRunnerProblem[] {
  const problems: RepoRunnerProblem[] = [];
  for (const cfg of repos) {
    const message = runnerConfigProblem(cfg, profiles, runners);
    if (message) problems.push({ repo: cfg.repo.id, message });
  }
  return problems;
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
