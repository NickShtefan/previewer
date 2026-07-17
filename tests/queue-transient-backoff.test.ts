import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, SqliteQueue, makeJob } from "../src/store";
import type { Db } from "../src/store";

interface TestClock {
  (): Date;
  advance(ms: number): void;
  nowMs(): number;
}
function fixedClock(startIso = "2026-06-21T00:00:00.000Z"): TestClock {
  let t = new Date(startIso);
  const fn = (() => t) as TestClock;
  fn.advance = (ms: number) => {
    t = new Date(t.getTime() + ms);
  };
  fn.nowMs = () => t.getTime();
  return fn;
}

const KEY = { repo: "owner/repo", prNumber: 7, headSha: "abc1234def567" };
const mkJob = () =>
  makeJob({ repo: KEY.repo, prNumber: KEY.prNumber, headSha: KEY.headSha, source: "webhook" });

/** Raw row read (Job doesn't expose visible_at / transient_attempts). */
function rawRow(db: Db): { visible_at: string; attempts: number; transient_attempts: number; status: string } {
  return db
    .prepare(
      `SELECT visible_at, attempts, transient_attempts, status FROM jobs WHERE repo=? AND pr_number=? AND head_sha=?`,
    )
    .get(KEY.repo, KEY.prNumber, KEY.headSha) as {
    visible_at: string;
    attempts: number;
    transient_attempts: number;
    status: string;
  };
}

describe("SqliteQueue — nackTransient (outage back-off, no dead-letter)", () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("requeues with exponential back-off (60s, 120s, 240s ... capped at 30min)", async () => {
    const clock = fixedClock();
    const q = new SqliteQueue(db, { clock });
    await q.enqueue(mkJob());

    // base 60s, doubling, capped at 1_800_000ms (30min).
    const expected = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000];
    for (let i = 0; i < expected.length; i++) {
      const leased = await q.lease(1000);
      expect(leased).not.toBeNull();
      await q.nackTransient(leased!.leaseId);

      const row = rawRow(db);
      expect(row.status).toBe("queued");
      expect(row.transient_attempts).toBe(i + 1);
      // The lease-time attempts++ is neutralised, so the dead-letter budget is untouched.
      expect(row.attempts).toBe(0);
      const delayMs = new Date(row.visible_at).getTime() - clock.nowMs();
      expect(delayMs).toBe(expected[i]);

      clock.advance(delayMs); // jump to when the job becomes visible again for the next round
    }
  });

  it("is not leasable until the back-off elapses", async () => {
    const clock = fixedClock();
    const q = new SqliteQueue(db, { clock });
    await q.enqueue(mkJob());
    const leased = await q.lease(1000);
    await q.nackTransient(leased!.leaseId); // first retry -> 60s

    clock.advance(59_000);
    expect(await q.lease(1000)).toBeNull(); // still backing off
    clock.advance(1_000); // now at 60s
    expect(await q.lease(1000)).not.toBeNull();
  });

  it("NEVER dead-letters, even past maxAttempts (unlike nack)", async () => {
    const clock = fixedClock();
    // maxAttempts=1 would dead-letter on the very first nack; nackTransient must not.
    const q = new SqliteQueue(db, { clock, maxAttempts: 1 });
    await q.enqueue(mkJob());

    for (let i = 0; i < 12; i++) {
      const leased = await q.lease(1000);
      expect(leased).not.toBeNull();
      await q.nackTransient(leased!.leaseId);
      expect(rawRow(db).status).toBe("queued"); // requeued, never dead_letter
      clock.advance(1_800_000); // skip past the (capped) back-off
    }
    const row = rawRow(db);
    expect(row.status).toBe("queued");
    expect(row.transient_attempts).toBe(12);
    expect(row.attempts).toBe(0);
  });

  it("force /rereview resets the transient counter", async () => {
    const clock = fixedClock();
    const q = new SqliteQueue(db, { clock });
    await q.enqueue(mkJob());
    const leased = await q.lease(1000);
    await q.nackTransient(leased!.leaseId);
    clock.advance(60_000);
    const leased2 = await q.lease(1000);
    await q.nackTransient(leased2!.leaseId);
    expect(rawRow(db).transient_attempts).toBe(2);

    expect(await q.enqueue(mkJob(), { force: true })).toBe("requeued");
    expect(rawRow(db).transient_attempts).toBe(0);
  });

  it("a stale lease (after re-lease) is a no-op", async () => {
    const clock = fixedClock();
    const q = new SqliteQueue(db, { clock });
    await q.enqueue(mkJob());
    const first = await q.lease(1000);
    clock.advance(2000); // lease expires
    const second = await q.lease(1000);

    await q.nackTransient(first!.leaseId); // stale — belongs to the expired lease
    expect(rawRow(db).status).toBe("running"); // untouched, still held by `second`
    await q.nackTransient(second!.leaseId); // current lease
    expect(rawRow(db).status).toBe("queued");
  });
});

describe("SqliteQueue — nextVisibleAt (wake-up scheduling for backed-off retries)", () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("returns null when nothing is backed off into the future", async () => {
    const q = new SqliteQueue(db, { clock: fixedClock() });
    expect(await q.nextVisibleAt()).toBeNull(); // empty queue
    await q.enqueue(mkJob()); // an immediately-visible job is not a FUTURE wake-up
    expect(await q.nextVisibleAt()).toBeNull();
  });

  it("returns the earliest future visible_at after a transient back-off", async () => {
    const clock = fixedClock();
    const q = new SqliteQueue(db, { clock });
    await q.enqueue(mkJob());
    await q.nackTransient((await q.lease(1000))!.leaseId); // -> visible in 60s
    const next = await q.nextVisibleAt();
    expect(next).not.toBeNull();
    expect(next!.getTime() - clock.nowMs()).toBe(60_000); // the wake-up target
  });

  it("stops reporting a job once its back-off has elapsed (it is leasable now, not 'future')", async () => {
    const clock = fixedClock();
    const q = new SqliteQueue(db, { clock });
    await q.enqueue(mkJob());
    await q.nackTransient((await q.lease(1000))!.leaseId);
    clock.advance(60_000); // back-off elapsed
    expect(await q.nextVisibleAt()).toBeNull(); // nothing left to wake for; it drains on the next kick
  });
});
