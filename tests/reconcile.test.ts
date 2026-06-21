import { describe, it, expect } from "vitest";
import { openDatabase, SqliteStore, SqliteQueue } from "../src/store";
import { reconcile, type ReconcileDeps } from "../src/apps/reconciler/reconcile";
import { RepoConfig } from "../src/config";
import type { ReviewRun } from "../src/config";
import type { PullRequestMeta } from "../src/core";

const pr = (n: number, head: string, draft = false): PullRequestMeta => ({
  number: n,
  title: `PR ${n}`,
  body: "",
  baseSha: "base",
  headSha: head,
  author: "a",
  isDraft: draft,
  state: "open",
});

const okRun = (prNumber: number, headSha: string): ReviewRun => ({
  id: `r-${prNumber}`,
  repo: "owner/repo",
  prNumber,
  headSha,
  status: "ok",
  tokensIn: 0,
  tokensOut: 0,
  usd: 0,
  durationMs: 0,
  error: null,
  startedAt: "2026-06-21T00:00:00.000Z",
  finishedAt: "2026-06-21T00:00:01.000Z",
});

function setup(prs: PullRequestMeta[]) {
  const db = openDatabase(":memory:");
  const store = new SqliteStore(db);
  const queue = new SqliteQueue(db);
  const cfg = RepoConfig.parse({ repo: { id: "owner/repo" } });
  const deps: ReconcileDeps = {
    repoConfigs: [cfg],
    github: {
      async listOpenPullRequests() {
        return prs;
      },
    },
    store,
    queue,
    logger: { info() {}, warn() {} },
    pipelineDepsFor: () => {
      throw new Error("drain not expected in this test");
    },
  };
  return { db, store, queue, deps };
}

describe("reconcile (completeness sweep)", () => {
  it("dry-run lists uncovered open non-draft PRs, skipping reviewed + drafts", async () => {
    const { store, deps } = setup([pr(1, "headA"), pr(2, "headB"), pr(3, "headC", true)]);
    await store.recordRun(okRun(1, "headA")); // #1 already reviewed

    const r = await reconcile(deps, { dryRun: true });
    expect(r.scanned).toBe(2); // #1 + #2 (open, non-draft); #3 is a draft
    expect(r.uncovered.map((u) => u.prNumber)).toEqual([2]);
    expect(r.enqueued).toBe(0);
  });

  it("enqueues uncovered SHAs idempotently (process: false)", async () => {
    const { queue, deps } = setup([pr(2, "headB")]);
    const r1 = await reconcile(deps, { process: false });
    expect(r1.enqueued).toBe(1);
    expect(queue.getByKey("owner/repo", 2, "headB")).not.toBeNull();

    const r2 = await reconcile(deps, { process: false }); // already queued
    expect(r2.enqueued).toBe(0);
  });

  it("isReviewed counts only successful runs (error does not)", async () => {
    const { store } = setup([]);
    expect(await store.isReviewed("owner/repo", 9, "h")).toBe(false);
    await store.recordRun({ ...okRun(9, "h"), id: "e", status: "error", error: "x" });
    expect(await store.isReviewed("owner/repo", 9, "h")).toBe(false);
    await store.recordRun(okRun(9, "h"));
    expect(await store.isReviewed("owner/repo", 9, "h")).toBe(true);
  });
});
