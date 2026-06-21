import type { ChangedFile, RepoConfig, RunnerSelector } from "../config";

export interface GatingDecision {
  action: "review" | "skip" | "light";
  reason: string;
}

export interface GatingInput {
  changedFiles: ChangedFile[];
  ignorePaths: string[];
}

export interface SelectionSignals {
  changeType?: string;
  size?: string;
  risk?: string;
}

/** Cheap, pre-model decisions: should we review, and with which runner. */
export interface Policy {
  gate(input: GatingInput): GatingDecision;
  selectRunner(repo: RepoConfig, signals: SelectionSignals): RunnerSelector;
}
