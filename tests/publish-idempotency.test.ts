import { describe, it, expect } from "vitest";
import { SingleCommentPublisher } from "../src/github";
import type { IssueCommentsApi } from "../src/github";

class FakeComments implements IssueCommentsApi {
  store: Array<{ id: number; body: string }> = [];
  creates = 0;
  updates = 0;
  private seq = 1;

  async list(): Promise<Array<{ id: number; body: string }>> {
    return this.store.map((c) => ({ ...c }));
  }
  async create(_repo: string, _issue: number, body: string): Promise<{ id: number }> {
    const c = { id: this.seq++, body };
    this.store.push(c);
    this.creates++;
    return { id: c.id };
  }
  async update(_repo: string, id: number, body: string): Promise<{ id: number }> {
    const c = this.store.find((x) => x.id === id)!;
    c.body = body;
    this.updates++;
    return { id };
  }
}

const REF = { repo: "owner/repo", prNumber: 7 };

describe("SingleCommentPublisher — one comment per head SHA, idempotent", () => {
  it("creates once for a SHA, then edits on retry (no duplicate)", async () => {
    const fake = new FakeComments();
    const pub = new SingleCommentPublisher(fake);

    const r1 = await pub.upsertReviewComment(REF, "headAAA", "first body");
    const r2 = await pub.upsertReviewComment(REF, "headAAA", "second body");

    expect(r1.commentId).toBe(r2.commentId);
    expect(fake.creates).toBe(1);
    expect(fake.updates).toBe(1);
    expect(fake.store).toHaveLength(1);
    expect(fake.store[0]!.body).toContain("second body");
  });

  it("creates a separate comment for a new head SHA", async () => {
    const fake = new FakeComments();
    const pub = new SingleCommentPublisher(fake);

    await pub.upsertReviewComment(REF, "headAAA", "a");
    await pub.upsertReviewComment(REF, "headBBB", "b");

    expect(fake.store).toHaveLength(2);
    expect(fake.creates).toBe(2);
    expect(fake.updates).toBe(0);
  });

  it("appends the hidden marker when the body omits it", async () => {
    const fake = new FakeComments();
    const pub = new SingleCommentPublisher(fake);
    await pub.upsertReviewComment(REF, "headAAA", "no marker here");
    expect(fake.store[0]!.body).toContain("<!-- ai-review:owner/repo#7@headAAA -->");
  });
});
