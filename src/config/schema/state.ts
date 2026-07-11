import { z } from "zod";
import { RepoId, Sha } from "./common";

/** The dedupe identity of a review: one run per (repo, pr, head SHA). */
export const ReviewKey = z.object({
  repo: RepoId,
  prNumber: z.number().int().positive(),
  headSha: Sha,
});
export type ReviewKey = z.infer<typeof ReviewKey>;

export const JobSource = z.enum(["webhook", "reconciler", "manual"]);
export type JobSource = z.infer<typeof JobSource>;

export const JobStatus = z.enum(["queued", "running", "done", "skipped", "error", "dead_letter"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const Job = z.object({
  id: z.string(),
  repo: RepoId,
  prNumber: z.number().int().positive(),
  headSha: Sha,
  baseSha: Sha.optional(),
  /** Force a full (base..head) review, bypassing incremental — set by the /rereview command. */
  full: z.boolean().default(false),
  source: JobSource,
  status: JobStatus.default("queued"),
  attempts: z.number().int().nonnegative().default(0),
  lockedAt: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type Job = z.infer<typeof Job>;

export const RunStatus = z.enum(["ok", "skipped", "error"]);
export type RunStatus = z.infer<typeof RunStatus>;

/** The audit record for one review-run; doubles as the dedupe row. */
export const ReviewRun = z.object({
  id: z.string(),
  repo: RepoId,
  prNumber: z.number().int().positive(),
  headSha: Sha,
  baseSha: Sha.optional(),
  runner: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  profile: z.string().optional(),
  status: RunStatus,
  commentId: z.number().int().optional(),
  tokensIn: z.number().int().nonnegative().default(0),
  tokensOut: z.number().int().nonnegative().default(0),
  usd: z.number().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
  error: z.string().nullable().default(null),
  startedAt: z.string(),
  finishedAt: z.string().nullable().default(null),
});
export type ReviewRun = z.infer<typeof ReviewRun>;

/** Webhook idempotency record (X-GitHub-Delivery). */
export const Delivery = z.object({
  githubDeliveryId: z.string(),
  receivedAt: z.string(),
});
export type Delivery = z.infer<typeof Delivery>;
