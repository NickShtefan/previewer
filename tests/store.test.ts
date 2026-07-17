import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase, SqliteStore, SqliteQueue, makeJob } from "../src/store";
import { migrate } from "../src/store/migrations";
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

  it("recordRun persists runner, model, and reasoningEffort", async () => {
    const run: ReviewRun = {
      id: "r-eff",
      repo: KEY.repo,
      prNumber: KEY.prNumber,
      headSha: KEY.headSha,
      runner: "claude-cli",
      model: "opus",
      reasoningEffort: "max",
      status: "ok",
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      durationMs: 0,
      error: null,
      startedAt: "2026-06-21T00:00:00.000Z",
      finishedAt: "2026-06-21T00:00:01.000Z",
    };
    await store.recordRun(run);
    const row = db
      .prepare("SELECT runner, model, reasoning_effort AS effort FROM review_runs WHERE id = ?")
      .get("r-eff") as { runner: string; model: string; effort: string };
    expect(row).toEqual({ runner: "claude-cli", model: "opus", effort: "max" });
  });

  it("delivery idempotency", async () => {
    expect(await store.seenDelivery("d1")).toBe(false);
    await store.markDelivery("d1");
    expect(await store.seenDelivery("d1")).toBe(true);
    await store.markDelivery("d1"); // must not throw on duplicate
    expect(await store.seenDelivery("d1")).toBe(true);
  });
});

describe("SqliteStore — isReviewedOrInFlight (in-flight + limit backoff)", () => {
  const T0 = "2026-06-21T00:00:00.000Z"; // matches fixedClock's default start
  const inFlight = (store: SqliteStore) =>
    store.isReviewedOrInFlight(KEY.repo, KEY.prNumber, KEY.headSha);
  const errorRun = (error: string): ReviewRun => ({
    id: "err",
    repo: KEY.repo,
    prNumber: KEY.prNumber,
    headSha: KEY.headSha,
    status: "error",
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    durationMs: 0,
    error,
    startedAt: T0,
    finishedAt: T0,
  });

  it("no row -> false", async () => {
    const store = new SqliteStore(openDatabase(":memory:"));
    expect(await inFlight(store)).toBe(false);
  });

  it("terminal ok / skipped -> true", async () => {
    const okStore = new SqliteStore(openDatabase(":memory:"));
    await okStore.recordRun({ ...errorRun("x"), id: "ok", status: "ok", error: null });
    expect(await inFlight(okStore)).toBe(true);

    const skipStore = new SqliteStore(openDatabase(":memory:"));
    await skipStore.recordRun({ ...errorRun("ignored path"), id: "sk", status: "skipped" });
    expect(await inFlight(skipStore)).toBe(true);
  });

  it("fresh 'running' -> true; stale 'running' (past staleMs) -> false", async () => {
    const clock = fixedClock();
    const store = new SqliteStore(openDatabase(":memory:"), clock);
    await store.claimReview(KEY); // inserts a 'running' row at T0
    expect(await inFlight(store)).toBe(true);

    clock.advance(16 * 60 * 1000); // past the 15-min stale window
    expect(await inFlight(store)).toBe(false);
  });

  it("fresh limit-classified error -> true (cooldown); after cooldown -> false", async () => {
    const clock = fixedClock();
    const store = new SqliteStore(openDatabase(":memory:"), clock);
    await store.recordRun(errorRun("429 Too Many Requests: usage limit reached"));
    expect(await inFlight(store)).toBe(true); // within cooldown -> back off

    clock.advance(16 * 60 * 1000); // past the 15-min cooldown
    expect(await inFlight(store)).toBe(false); // now retryable
  });

  it("fresh non-limit error -> false (keeps retrying immediately)", async () => {
    const clock = fixedClock();
    const store = new SqliteStore(openDatabase(":memory:"), clock);
    await store.recordRun(errorRun("TypeError: cannot read property of undefined"));
    expect(await inFlight(store)).toBe(false);
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

  it("force re-queues an existing head (rereview): a completed job becomes leasable again", async () => {
    const q = new SqliteQueue(db);
    expect(await q.enqueue(mkJob())).toBe("enqueued");
    const leased = await q.lease(1000);
    await q.ack(leased!.leaseId);
    expect(q.getByKey(KEY.repo, KEY.prNumber, KEY.headSha)!.status).toBe("done");

    expect(await q.enqueue(mkJob())).toBe("duplicate"); // unforced: still a no-op
    expect(await q.enqueue({ ...mkJob(), full: true }, { force: true })).toBe("requeued");

    const job = q.getByKey(KEY.repo, KEY.prNumber, KEY.headSha)!;
    expect(job.status).toBe("queued");
    expect(job.full).toBe(true); // full flag threaded onto the re-queued job
    const released = await q.lease(1000);
    expect(released).not.toBeNull();
    expect(released!.full).toBe(true);
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

describe("migrate — idempotent column backfill", () => {
  const hasReasoningEffort = (db: Db): boolean =>
    (db.prepare("PRAGMA table_info(review_runs)").all() as Array<{ name: string }>).some(
      (c) => c.name === "reasoning_effort",
    );

  it("adds reasoning_effort to a legacy review_runs table and is safe to re-run", () => {
    const db = new Database(":memory:") as Db;
    // A review_runs table predating the reasoning_effort column.
    db.exec(`CREATE TABLE review_runs (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL, runner TEXT, model TEXT, profile TEXT, status TEXT NOT NULL,
      comment_id INTEGER, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
      usd REAL NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, error TEXT,
      started_at TEXT NOT NULL, finished_at TEXT, UNIQUE(repo, pr_number, head_sha)
    );`);
    expect(hasReasoningEffort(db)).toBe(false);
    migrate(db);
    expect(hasReasoningEffort(db)).toBe(true);
    expect(() => migrate(db)).not.toThrow(); // second run must not re-add the column
    expect(hasReasoningEffort(db)).toBe(true);
  });

  it("a fresh database already has reasoning_effort", () => {
    const db = openDatabase(":memory:");
    expect(hasReasoningEffort(db)).toBe(true);
  });
});

describe("SqliteStore — releaseClaim (un-finalized claim cleanup)", () => {
  let db: Db;
  let store: SqliteStore;
  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SqliteStore(db);
  });

  const okRun = (): ReviewRun => ({
    id: "r",
    repo: KEY.repo,
    prNumber: KEY.prNumber,
    headSha: KEY.headSha,
    status: "ok",
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    durationMs: 0,
    error: null,
    startedAt: "2026-06-21T00:00:00.000Z",
    finishedAt: "2026-06-21T00:00:01.000Z",
  });

  it("releases a 'running' claim so a retry can re-claim (review not lost)", async () => {
    await store.claimReview(KEY, { claimId: "c1" });
    expect(await store.claimReview(KEY)).toBe("duplicate"); // held by the un-finalized claim
    await store.releaseClaim(KEY, "c1"); // the owner releases
    expect(await store.claimReview(KEY)).toBe("claimed"); // freed -> the retry actually runs
  });

  it("is a no-op on a finalized run (keeps the dedupe/audit record)", async () => {
    await store.claimReview(KEY, { claimId: "c1" });
    await store.recordRun(okRun()); // status 'ok' — a real record
    await store.releaseClaim(KEY, "c1");
    expect(await store.isReviewed(KEY.repo, KEY.prNumber, KEY.headSha)).toBe(true); // still deduped
    expect(await store.claimReview(KEY)).toBe("duplicate"); // success still blocks re-review
  });

  it("is a no-op when there is no claim row", async () => {
    await expect(store.releaseClaim(KEY, "whatever")).resolves.toBeUndefined();
  });

  it("does NOT delete a claim reclaimed by a newer owner (ownership scoping)", async () => {
    expect(await store.claimReview(KEY, { claimId: "c1" })).toBe("claimed"); // worker A
    // A newer worker force-reclaims the same head (the /rereview-during-in-flight race): the row
    // now carries c2. A finally throws and releases ITS token — it must NOT drop c2's live claim,
    // or a third worker could re-claim and double-spend the model.
    expect(await store.claimReview(KEY, { force: true, claimId: "c2" })).toBe("claimed");
    await store.releaseClaim(KEY, "c1"); // A's stale release
    expect(await store.claimReview(KEY)).toBe("duplicate"); // c2 still holds the claim
    await store.releaseClaim(KEY, "c2"); // the true owner can release
    expect(await store.claimReview(KEY)).toBe("claimed");
  });
});

describe("SqliteStore — ownership on finalize (ownsClaim + owner-scoped recordRun)", () => {
  let db: Db;
  let store: SqliteStore;
  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SqliteStore(db);
  });

  const okRun = (id: string, runner: string): ReviewRun => ({
    id,
    repo: KEY.repo,
    prNumber: KEY.prNumber,
    headSha: KEY.headSha,
    status: "ok",
    runner,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    durationMs: 0,
    error: null,
    startedAt: "2026-06-21T00:00:00.000Z",
    finishedAt: "2026-06-21T00:00:01.000Z",
  });

  it("ownsClaim tracks the current owner (false once reclaimed or finalized)", async () => {
    await store.claimReview(KEY, { claimId: "c1" });
    expect(await store.ownsClaim(KEY, "c1")).toBe(true);
    expect(await store.ownsClaim(KEY, "someone-else")).toBe(false);
    await store.claimReview(KEY, { force: true, claimId: "c2" }); // a newer worker reclaims
    expect(await store.ownsClaim(KEY, "c1")).toBe(false); // old owner lost it
    expect(await store.ownsClaim(KEY, "c2")).toBe(true);
  });

  it("recordRun(expectClaimId) will not overwrite a row reclaimed by a newer owner", async () => {
    await store.claimReview(KEY, { claimId: "c1" });
    await store.claimReview(KEY, { force: true, claimId: "c2" }); // c2 now owns the running claim
    // The superseded worker c1 tries to finalize — must be a no-op (audit provenance stays with c2).
    await store.recordRun(okRun("c1", "stale-worker"), { expectClaimId: "c1" });
    expect(await store.ownsClaim(KEY, "c2")).toBe(true); // still c2's live claim, not flipped to 'ok'
    expect(await store.isReviewed(KEY.repo, KEY.prNumber, KEY.headSha)).toBe(false);
    // The true owner c2 finalizes — succeeds.
    await store.recordRun(okRun("c2", "live-worker"), { expectClaimId: "c2" });
    expect(await store.isReviewed(KEY.repo, KEY.prNumber, KEY.headSha)).toBe(true);
  });

  it("recordRun without expectClaimId is unconditional (back-compat)", async () => {
    await store.claimReview(KEY, { claimId: "c1" });
    await store.recordRun(okRun("c1", "w")); // no guard
    expect(await store.isReviewed(KEY.repo, KEY.prNumber, KEY.headSha)).toBe(true);
  });
});
