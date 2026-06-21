import { z } from "zod";

/**
 * Comment publishing policy. Hard product invariant: exactly ONE plain top-level
 * comment per head SHA, never a formal GitHub review. Idempotency comes from an
 * embedded hidden marker (`identityMarker`) so retries upsert instead of duplicating.
 */
export const CommentPublishingPolicy = z.object({
  mode: z.literal("single_top_level_comment").default("single_top_level_comment"),
  formalReview: z.literal(false).default(false),
  identityMarker: z.string().default("<!-- ai-review:{repo}#{pr}@{head_sha} -->"),
  strategy: z
    .object({
      perHeadSha: z.enum(["new_comment"]).default("new_comment"),
      onSupersede: z.enum(["leave", "collapse_previous"]).default("leave"),
      onRetry: z.enum(["upsert_by_marker"]).default("upsert_by_marker"),
    })
    .default({}),
  include: z
    .object({
      headSha: z.boolean().default(true),
      activeProfiles: z.boolean().default(true), // list active profiles in the comment
      testsSummary: z.boolean().default(true), // list tests run vs NOT run (honesty)
      runnerMeta: z.enum(["none", "footer"]).default("footer"),
      severitySummary: z.boolean().default(true),
    })
    .default({}),
  onNoFindings: z.enum(["post_minimal", "skip"]).default("post_minimal"),
  onError: z.enum(["skip", "post_error_notice"]).default("skip"),
  sizeLimit: z.number().int().positive().default(65000),
});
export type CommentPublishingPolicy = z.infer<typeof CommentPublishingPolicy>;
