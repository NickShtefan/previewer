import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, SqliteStore, SqliteQueue, makeJob } from "../src/store";
import type { Db } from "../src/store";
import type { ReviewRun } from "../src/config";

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

const KEY = { repo: "owner/repo", prNumber: 7, headSha: "abc1234def567" };
const mkJob = () =>
  makeJob({ repo: KEY.repo, prNumber: KEY.prNumber, headSha: KEY.headSha, source: "manual" });

describe("SqliteStore — dedupe + audit", () => {
  let db: Db;
  let store: SqliteStore;
  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SqliteStore(db);
  });

  it("claimReview is idempotent on (repo, pr, head_sha)", async () => {
    expect(await store.claimReview(KEY)).toBe("claimed");
    expect(await store.claimReview(KEY)).toBe("duplicate");
  });

  it("reclaims a failed claim; force overrides a completed one", async () => {
    const run = (status: "ok" | "error"): ReviewRun => ({
      id: "r",
      repo: KEY.repo,
      prNumber: KEY.prNumber,
      headSha: KEY.headSha,
      status,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      durationMs: 0,
      error: null,
      startedAt: "2026-06-21T00:00:00.000Z",
      finishedAt: "2026-06-21T00:00:01.000Z",
    });
    await store.claimReview(KEY);
    await store.recordRun(run("error"));
    expect(await store.claimReview(KEY)).toBe("claimed"); // a failed run is retryable
    await store.recordRun(run("ok"));
    expect(await store.claimReview(KEY)).toBe("duplicate"); // a success blocks
    expect(await store.claimReview(KEY, { force: true })).toBe("claimed"); // force overrides
  });

  it("recordRun finalizes the claim; lastReviewedSha returns it", async () => {
    await store.claimReview(KEY);
    const run: ReviewRun = {
      id: "r1",
      repo: KEY.repo,
      prNumber: KEY.prNumber,
      headSha: KEY.headSha,
      status: "ok",
      tokensIn: 10,
      tokensOut: 20,
      usd: 0.01,
      durationMs: 100,
      error: null,
      startedAt: "2026-06-21T00:00:00.000Z",
      finishedAt: "2026-06-21T00:00:01.000Z",
    };
    await store.recordRun(run);
    expect(await store.lastReviewedSha(KEY.repo, KEY.prNumber)).toBe(KEY.headSha);
  });

  it("recordRun works without a prior claim (direct upsert)", async () => {
    const run: ReviewRun = {
      id: "r2",
      repo: KEY.repo,
      prNumber: 99,
      headSha: "deadbeef00",
      status: "skipped",
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      durationMs: 5,
      error: null,
      startedAt: "2026-06-21T00:00:00.000Z",
      finishedAt: "2026-06-21T00:00:00.500Z",
    };
    await store.recordRun(run);
    expect(await store.lastReviewedSha(KEY.repo, 99)).toBe("deadbeef00");
  });

  it("delivery idempotency", async () => {
    expect(await store.seenDelivery("d1")).toBe(false);
    await store.markDelivery("d1");
    expect(await store.seenDelivery("d1")).toBe(true);
    await store.markDelivery("d1"); // must not throw on duplicate
    expect(await store.seenDelivery("d1")).toBe(true);
  });
});

describe("SqliteQueue — durable jobs", () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("enqueue is idempotent per ReviewKey", async () => {
    const q = new SqliteQueue(db);
    expect(await q.enqueue(mkJob())).toBe("enqueued");
    expect(await q.enqueue(mkJob())).toBe("duplicate"); // same key, different id
  });

  it("lease -> ack completes a job, nothing left to lease", async () => {
    const q = new SqliteQueue(db);
    await q.enqueue(mkJob());
    const leased = await q.lease(1000);
    expect(leased).not.toBeNull();
    expect(leased!.attempts).toBe(1);
    expect(leased!.status).toBe("running");
    await q.ack(leased!.leaseId);
    expect(q.getByKey(KEY.repo, KEY.prNumber, KEY.headSha)!.status).toBe("done");
    expect(await q.lease(1000)).toBeNull();
  });

  it("an expired lease makes the job leasable again; attempts grows", async () => {
    const clock = fixedClock();
    const q = new SqliteQueue(db, { clock });
    await q.enqueue(mkJob());

    const first = await q.lease(1000);
    expect(first!.attempts).toBe(1);
    expect(await q.lease(1000)).toBeNull(); // still locked within the visibility window

    clock.advance(2000); // lease expired
    const second = await q.lease(1000);
    expect(second).not.toBeNull();
    expect(second!.attempts).toBe(2);
  });

  it("nack requeues until maxAttempts, then dead_letter", async () => {
    const clock = fixedClock();
    const q = new SqliteQueue(db, { clock, maxAttempts: 3 });
    await q.enqueue(mkJob());

    for (let i = 0; i < 3; i++) {
      const leased = await q.lease(1000);
      expect(leased).not.toBeNull();
      await q.nack(leased!.leaseId, 0);
    }

    const job = q.getByKey(KEY.repo, KEY.prNumber, KEY.headSha)!;
    expect(job.status).toBe("dead_letter");
    expect(job.attempts).toBe(3);
    expect(await q.lease(1000)).toBeNull(); // dead jobs are not leasable
  });

  it("nack respects the retry delay (not leasable until it elapses)", async () => {
    const clock = fixedClock();
    const q = new SqliteQueue(db, { clock, maxAttempts: 5 });
    await q.enqueue(mkJob());
    const leased = await q.lease(1000);
    await q.nack(leased!.leaseId, 5000); // retry in 5s
    expect(await q.lease(1000)).toBeNull(); // delay not elapsed
    clock.advance(6000);
    expect(await q.lease(1000)).not.toBeNull();
  });

  it("a stale ack after re-lease is ignored", async () => {
    const clock = fixedClock();
    const q = new SqliteQueue(db, { clock });
    await q.enqueue(mkJob());
    const first = await q.lease(1000);
    clock.advance(2000);
    const second = await q.lease(1000);

    await q.ack(first!.leaseId); // stale — belongs to an expired lease
    expect(q.getByKey(KEY.repo, KEY.prNumber, KEY.headSha)!.status).toBe("running");
    await q.ack(second!.leaseId); // current lease
    expect(q.getByKey(KEY.repo, KEY.prNumber, KEY.headSha)!.status).toBe("done");
  });
});
