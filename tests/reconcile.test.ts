import { describe, it, expect } from "vitest";
import { openDatabase, SqliteStore, SqliteQueue } from "../src/store";
import type { Clock } from "../src/store";
import { reconcile, type ReconcileDeps } from "../src/apps/reconciler/reconcile";
import { RepoConfig } from "../src/config";
import type { ReviewRun } from "../src/config";
import type { PullRequestMeta } from "../src/core";

interface TestClock {
  (): Date;
  advance(ms: number): void;
}
function fixedClock(startIso = "2026-06-21T00:00:00.000Z"): TestClock {
  let t = new Date(startIso);
  const fn = (() => t) as TestClock;
  fn.advance = (ms: number) => {
    t = new Date(t.getTime() + ms);
  };
  return fn;
}

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

function setup(prs: PullRequestMeta[], clock?: Clock) {
  const db = openDatabase(":memory:");
  const store = new SqliteStore(db, clock);
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

  it("a head with a live in-flight ('running') review is NOT re-enqueued", async () => {
    const clock = fixedClock();
    const { store, deps } = setup([pr(2, "headB")], clock);
    // A forced review is mid-flight: claimReview inserts a 'running' row at T0.
    expect(await store.claimReview({ repo: "owner/repo", prNumber: 2, headSha: "headB" })).toBe(
      "claimed",
    );

    const r = await reconcile(deps, { dryRun: true });
    expect(r.scanned).toBe(1);
    expect(r.uncovered).toEqual([]); // covered by the in-flight review -> no duplicate spend
  });

  it("a stale ('running' older than staleMs) review IS uncovered (dead run retried)", async () => {
    const clock = fixedClock();
    const { store, deps } = setup([pr(2, "headB")], clock);
    await store.claimReview({ repo: "owner/repo", prNumber: 2, headSha: "headB" }); // running at T0

    clock.advance(16 * 60 * 1000); // past the 15-min stale window: the worker is presumed dead
    const r = await reconcile(deps, { dryRun: true });
    expect(r.uncovered.map((u) => u.prNumber)).toEqual([2]);
  });

  it("a recent limit-classified error is NOT re-enqueued (cooldown); a non-limit error is", async () => {
    const clock = fixedClock();
    const { store, deps } = setup([pr(2, "headB"), pr(3, "headC")], clock);
    // #2 failed on a usage limit; #3 failed on an ordinary bug; both at T0.
    await store.recordRun({
      ...okRun(2, "headB"),
      id: "lim",
      status: "error",
      error: "429 Too Many Requests: usage limit reached",
      startedAt: "2026-06-21T00:00:00.000Z",
      finishedAt: "2026-06-21T00:00:00.000Z",
    });
    await store.recordRun({
      ...okRun(3, "headC"),
      id: "bug",
      status: "error",
      error: "TypeError: cannot read property of undefined",
      startedAt: "2026-06-21T00:00:00.000Z",
      finishedAt: "2026-06-21T00:00:00.000Z",
    });

    // Within cooldown: only the non-limit error (#3) is retried; the limit head (#2) backs off.
    const r1 = await reconcile(deps, { dryRun: true });
    expect(r1.uncovered.map((u) => u.prNumber)).toEqual([3]);

    // After the cooldown elapses, the limit head is retried too.
    clock.advance(16 * 60 * 1000);
    const r2 = await reconcile(deps, { dryRun: true });
    expect(r2.uncovered.map((u) => u.prNumber).sort()).toEqual([2, 3]);
  });
});
