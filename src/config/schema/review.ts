import { z } from "zod";
import { RepoId, Sha, SizeClass, Severity, Depth } from "./common";
import { ReviewProfile, Invariant, SubsystemGuide, SecurityBaseline, RiskEntry } from "./pack";

export const ChangedFile = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "removed", "renamed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  language: z.string().optional(),
  sizeClass: SizeClass.default("small"),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

export const TokenBudget = z.object({
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  depthHint: Depth.default("normal"),
});
export type TokenBudget = z.infer<typeof TokenBudget>;

/** Context already narrowed by routing — never the whole pack (cost control). */
export const ResolvedContext = z.object({
  packVersion: z.string(),
  repoGuideExcerpt: z.string().default(""),
  subsystems: z.array(SubsystemGuide).default([]),
  invariants: z.array(Invariant).default([]),
  securityBaseline: SecurityBaseline,
  /** The pack's comment template (output shape handed to the runner). */
  commentTemplate: z.string().default(""),
  /** Names of all active profiles (mandatory + route-activated), for the comment. */
  activeProfiles: z.array(z.string()).default([]),
  /** The merged set of active profile definitions. */
  profiles: z.array(ReviewProfile).default([]),
  /** Deduped union of test commands across active profiles. */
  tests: z.array(z.string()).default([]),
  /** Docs loaded into context (audit / "what I read"). */
  requiredDocs: z.array(z.string()).default([]),
  riskMap: z.array(RiskEntry).default([]),
});
export type ResolvedContext = z.infer<typeof ResolvedContext>;

/** The single contract every runner consumes — must satisfy both CLI and API backends. */
export const ReviewInput = z.object({
  repo: z.object({ id: RepoId, defaultBranch: z.string() }),
  pr: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().default(""),
    baseSha: Sha,
    headSha: Sha,
    author: z.string(),
    isDraft: z.boolean().default(false),
  }),
  diff: z.object({
    mode: z.enum(["incremental", "full"]),
    fromSha: Sha,
    toSha: Sha,
    patch: z.string(),
    changedFiles: z.array(ChangedFile),
  }),
  context: ResolvedContext,
  output: z.object({
    commentTemplate: z.string().default(""),
    language: z.enum(["ru", "en"]).default("en"),
    maxCommentChars: z.number().int().positive().default(65000),
  }),
  budget: TokenBudget,
  workspace: z
    .object({
      dir: z.string(),
      allowTests: z.boolean().default(false),
      readBudgetFiles: z.number().int().nonnegative().default(20),
    })
    .optional(),
});
export type ReviewInput = z.infer<typeof ReviewInput>;

export const Finding = z.object({
  title: z.string(),
  severity: Severity,
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  category: z.string().default("correctness"),
  detail: z.string().default(""),
});
export type Finding = z.infer<typeof Finding>;

/** What a runner returns. `reviewedHeadSha` must echo the input head SHA. */
export const ReviewResult = z.object({
  status: z.enum(["ok", "skipped", "error"]),
  reviewedHeadSha: Sha,
  comment: z
    .object({
      bodyMarkdown: z.string(),
      severitySummary: z.record(z.string(), z.number()).optional(),
    })
    .optional(),
  findings: z.array(Finding).default([]),
  meta: z.object({
    runnerId: z.string(),
    model: z.string(),
    profile: z.string(),
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
  error: z
    .object({ kind: z.string(), message: z.string(), retriable: z.boolean() })
    .optional(),
});
export type ReviewResult = z.infer<typeof ReviewResult>;
