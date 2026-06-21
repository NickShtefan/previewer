import type { Publisher, PrRef } from "../core";
import { commentMarker } from "../core";
import type { IssueCommentsApi } from "./ports";

const DEFAULT_MARKER = "<!-- ai-review:{repo}#{pr}@{head_sha} -->";

/**
 * Publishes exactly one top-level comment per head SHA. Idempotency comes from a
 * hidden per-(repo,pr,head_sha) marker: on rerun for the same SHA we find our
 * prior comment and edit it; a new SHA gets a fresh comment. Never a formal review.
 */
export class SingleCommentPublisher implements Publisher {
  constructor(
    private readonly comments: IssueCommentsApi,
    private readonly markerTemplate: string = DEFAULT_MARKER,
  ) {}

  async upsertReviewComment(ref: PrRef, headSha: string, body: string): Promise<{ commentId: number }> {
    const marker = commentMarker(this.markerTemplate, ref.repo, ref.prNumber, headSha);
    const finalBody = body.includes(marker) ? body : `${body}\n\n${marker}`;

    const existing = await this.comments.list(ref.repo, ref.prNumber);
    const mine = existing.find((c) => c.body.includes(marker));

    if (mine) {
      const r = await this.comments.update(ref.repo, mine.id, finalBody);
      return { commentId: r.id };
    }
    const r = await this.comments.create(ref.repo, ref.prNumber, finalBody);
    return { commentId: r.id };
  }
}
