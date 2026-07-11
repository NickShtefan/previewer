import type {
  RepoConfig,
  RunnerSelector,
  RunnerProfiles,
  ChangedFile,
  ResolvedContext,
  ChangeType,
  SizeClass,
  RiskLevel,
} from "../../config";
import { resolveRunnerProfile } from "../../config";
import { sizeClassOf } from "../../github";

export interface Signals {
  changeType: ChangeType;
  size: SizeClass;
  risk: RiskLevel;
}

/** Derive cheap signals for runner selection from the diff + resolved context. */
export function changeSignals(changedFiles: ChangedFile[], resolved: ResolvedContext): Signals {
  const churn = changedFiles.reduce((n, f) => n + f.additions + f.deletions, 0);
  const severities = new Set(resolved.invariants.map((i) => i.severity));
  const risk: RiskLevel =
    severities.has("critical") || severities.has("high")
      ? "high"
      : resolved.invariants.length > 0
        ? "medium"
        : "low";
  return { changeType: inferChangeType(changedFiles), size: sizeClassOf(churn), risk };
}

function inferChangeType(files: ChangedFile[]): ChangeType {
  const paths = files.map((f) => f.path);
  if (paths.some((p) => /(^|\/)migrations?\//i.test(p) || p.endsWith(".sql"))) return "migration";
  if (paths.length > 0 && paths.every((p) => p.endsWith(".md"))) return "docs";
  if (paths.some((p) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(p))) return "deps";
  return "other";
}

function whenMatches(
  when: { changeType?: ChangeType; size?: SizeClass; risk?: RiskLevel },
  s: Signals,
): boolean {
  if (when.changeType && when.changeType !== s.changeType) return false;
  if (when.size && when.size !== s.size) return false;
  if (when.risk && when.risk !== s.risk) return false;
  return true;
}

/** First matching override wins; otherwise the repo default runner. */
export function selectRunnerSelector(
  cfg: RepoConfig,
  signals: Signals,
  profiles: RunnerProfiles = {},
): RunnerSelector {
  const base = {
    policy: cfg.runner.policy,
    changeType: signals.changeType,
    size: signals.size,
    risk: signals.risk,
  };
  // Change-signal overrides keep their inline runner/model/effort and win when matched.
  for (const ov of cfg.runner.overrides) {
    if (whenMatches(ov.when, signals))
      return { ...base, preferred: ov.use, model: ov.model, reasoningEffort: ov.reasoningEffort };
  }
  // Otherwise the repo's active client comes from its profile (or the inline block as a fallback).
  const active = resolveRunnerProfile(cfg.runner, profiles);
  return {
    ...base,
    preferred: active.runner,
    model: active.model,
    reasoningEffort: active.reasoningEffort,
  };
}
