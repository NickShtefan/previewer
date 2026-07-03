import { z } from "zod";

/** `owner/name` repository identifier. */
export const RepoId = z.string().regex(/^[^/\s]+\/[^/\s]+$/, "expected owner/name");
export type RepoId = z.infer<typeof RepoId>;

export const Sha = z.string().min(7);
export type Sha = z.infer<typeof Sha>;

/** A glob pattern (matched against repo-relative paths). */
export const Glob = z.string();

export const SizeClass = z.enum(["tiny", "small", "medium", "large", "huge"]);
export type SizeClass = z.infer<typeof SizeClass>;

export const RiskLevel = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

/**
 * Reasoning effort level, passed to runners that support it (claude `--effort`, codex
 * `model_reasoning_effort`). claude accepts the full ladder; codex tops out at `high`, so
 * runners clamp levels their backend does not support (see codex runner).
 */
export const ReasoningEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const ChangeType = z.enum([
  "feature",
  "bugfix",
  "refactor",
  "migration",
  "docs",
  "deps",
  "config",
  "test",
  "infra",
  "other",
]);
export type ChangeType = z.infer<typeof ChangeType>;

export const Depth = z.enum(["shallow", "normal", "deep"]);
export type Depth = z.infer<typeof Depth>;

export const Severity = z.enum(["info", "low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;
