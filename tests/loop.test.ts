import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, SqliteQueue, makeJob } from "../src/store";
import type { Db } from "../src/store";
import { processLeased, drainQueue, type DrainOptions } from "../src/apps/worker/loop";
import type { PipelineDeps, PipelineOutcome, ReviewRequest } from "../src/apps/worker/pipeline";

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
  makeJob({ repo: KEY.repo, prNumber: KEY.prNumber, headSha: KEY.headSha, source: "webhook" });

function rawRow(db: Db): { attempts: number; transient_attempts: number; status: string } {
  return db
    .prepare(`SELECT attempts, transient_attempts, status FROM jobs WHERE repo=? AND pr_number=? AND head_sha=?`)
    .get(KEY.repo, KEY.prNumber, KEY.headSha) as { attempts: number; transient_attempts: number; status: string };
}

// The injected pipeline ignores deps; a bare stub satisfies the type.
const STUB_DEPS = {} as unknown as PipelineDeps;
const run = (fn: (req: ReviewRequest) => Promise<PipelineOutcome>): DrainOptions["runPipeline"] =>
  (_deps, req) => fn(req);

const httpError = (status: number, message = `HTTP ${status}`): Error => {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
};

describe("processLeased — thrown pipeline errors never strand the job", () => {
  let db: Db;
  let clock: TestClock;
  beforeEach(() => {
    db = openDatabase(":memory:");
    clock = fixedClock();
  });

  it("a thrown TRANSIENT error requeues with back-off (not running, not dead_letter)", async () => {
    const q = new SqliteQueue(db, { clock });
    await q.enqueue(mkJob());
    const leased = await q.lease(2_100_000);

    await processLeased(q, leased!, STUB_DEPS, {
      runPipeline: run(async () => {
        throw new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`); // GitHub 503 HTML page
      }),
    });

    const row = rawRow(db);
    expect(row.status).toBe("queued"); // requeued, NOT left in 'running'
    expect(row.transient_attempts).toBe(1);
    expect(row.attempts).toBe(0); // dead-letter budget untouched
    expect(await q.lease(2_100_000)).toBeNull(); // backing off, not immediately leasable
  });

  it("survives many transient failures without dead-lettering (maxAttempts would otherwise trip)", async () => {
    const q = new SqliteQueue(db, { clock, maxAttempts: 1 });
    await q.enqueue(mkJob());
    const throwTransient = run(async () => {
      throw httpError(503, "Service Unavailable");
    });

    for (let i = 0; i < 15; i++) {
      const leased = await q.lease(2_100_000);
      expect(leased).not.toBeNull();
      await processLeased(q, leased!, STUB_DEPS, { runPipeline: throwTransient });
      expect(rawRow(db).status).toBe("queued"); // never dead_letter across a long outage
      clock.advance(1_800_000); // skip the (capped) back-off to the next attempt
    }
    const row = rawRow(db);
    expect(row.transient_attempts).toBe(15);
    expect(row.attempts).toBe(0);
  });

  it("a thrown PERMANENT error uses the bounded attempts -> dead_letter path", async () => {
    const q = new SqliteQueue(db, { clock, maxAttempts: 2 });
    await q.enqueue(mkJob());
    const throwPermanent = run(async () => {
      throw httpError(422, "Validation Failed");
    });

    // cycle 1: attempts 0->1, nack requeues (1 < 2)
    await processLeased(q, (await q.lease(2_100_000))!, STUB_DEPS, { runPipeline: throwPermanent });
    expect(rawRow(db).status).toBe("queued");
    clock.advance(60_000); // default nack retry delay

    // cycle 2: attempts 1->2, nack dead-letters (2 >= 2)
    await processLeased(q, (await q.lease(2_100_000))!, STUB_DEPS, { runPipeline: throwPermanent });
    const row = rawRow(db);
    expect(row.status).toBe("dead_letter");
    expect(row.attempts).toBe(2);
  });
});

describe("processLeased — structured (returned) error outcomes", () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("routes a transient-looking retriable outcome to the no-dead-letter back-off", async () => {
    const q = new SqliteQueue(db, { clock: fixedClock(), maxAttempts: 1 });
    await q.enqueue(mkJob());
    const leased = await q.lease(2_100_000);
    await processLeased(q, leased!, STUB_DEPS, {
      runPipeline: run(async () => ({ status: "error", message: "503 Service Unavailable", retriable: true })),
    });
    const row = rawRow(db);
    expect(row.status).toBe("queued"); // not dead_letter despite maxAttempts=1
    expect(row.transient_attempts).toBe(1);
    expect(row.attempts).toBe(0);
  });

  it("routes a KNOWN-permanent retriable outcome (auth) to the attempts budget (nack)", async () => {
    const q = new SqliteQueue(db, { clock: fixedClock(), maxAttempts: 1 });
    await q.enqueue(mkJob());
    const leased = await q.lease(2_100_000);
    await processLeased(q, leased!, STUB_DEPS, {
      runPipeline: run(async () => ({ status: "error", message: "Bad credentials", retriable: true })),
    });
    expect(rawRow(db).status).toBe("dead_letter"); // permanent -> cap = maxAttempts(1), attempts(1) >= 1
  });

  it("acks a successful (non-error) outcome", async () => {
    const q = new SqliteQueue(db, { clock: fixedClock() });
    await q.enqueue(mkJob());
    const leased = await q.lease(2_100_000);
    await processLeased(q, leased!, STUB_DEPS, {
      runPipeline: run(async () => ({ status: "skipped", reason: "no reviewable files" })),
    });
    expect(rawRow(db).status).toBe("done");
  });
});

describe("processLeased — unknown (unclassified) failures", () => {
  // A 3xx status is neither transient (5xx/429) nor known-permanent (4xx/auth) -> unknown.
  const unknownError = (): Error => {
    const e = new Error("mystery upstream failure XYZ") as Error & { status: number; code: string };
    e.status = 301;
    e.code = "EWEIRD";
    return e;
  };

  it("journals the error in detail and dead_letters after ~3 bounded attempts (not sooner, not infinite)", async () => {
    const db = openDatabase(":memory:");
    const clock = fixedClock();
    // Permanent budget is 5; the UNKNOWN budget must be smaller (default 3) and win here.
    const q = new SqliteQueue(db, { clock, maxAttempts: 5 });
    await q.enqueue(mkJob());
    const logs: string[] = [];
    const opts: DrainOptions = {
      logger: { warn: (m) => logs.push(m) },
      runPipeline: run(async () => {
        throw unknownError();
      }),
    };

    // attempt 1 & 2: requeued (not dead-lettered sooner than the cap)
    await processLeased(q, (await q.lease(2_100_000))!, STUB_DEPS, opts);
    expect(rawRow(db).status).toBe("queued");
    clock.advance(60_000);
    await processLeased(q, (await q.lease(2_100_000))!, STUB_DEPS, opts);
    expect(rawRow(db).status).toBe("queued");
    clock.advance(60_000);
    // attempt 3: dead_letter (bounded, NOT infinite)
    await processLeased(q, (await q.lease(2_100_000))!, STUB_DEPS, opts);
    expect(rawRow(db).status).toBe("dead_letter");

    // Journaled once per occurrence, with the full diagnostic picture.
    expect(logs.length).toBe(3);
    const line = logs[0];
    expect(line).toContain("unclassified failure"); // greppable prefix
    expect(line).toContain("mystery upstream failure XYZ"); // message
    expect(line).toContain("status=301");
    expect(line).toContain("code=EWEIRD");
    expect(line).toContain("name=Error");
    expect(line).toContain("stack:"); // stack trace present
    expect(line).toMatch(/at .*loop\.test/); // an actual stack frame
  });

  it("uses a configurable unknown cap", async () => {
    const db = openDatabase(":memory:");
    const clock = fixedClock();
    const q = new SqliteQueue(db, { clock, maxAttempts: 10 });
    await q.enqueue(mkJob());
    const opts: DrainOptions = {
      unknownMaxAttempts: 2, // tighter than the default 3
      logger: { warn: () => {} },
      runPipeline: run(async () => {
        throw unknownError();
      }),
    };
    await processLeased(q, (await q.lease(2_100_000))!, STUB_DEPS, opts);
    expect(rawRow(db).status).toBe("queued");
    clock.advance(60_000);
    await processLeased(q, (await q.lease(2_100_000))!, STUB_DEPS, opts);
    expect(rawRow(db).status).toBe("dead_letter"); // attempts(2) >= unknownMaxAttempts(2)
  });

  it("routes a structured unknown retriable outcome through the same bounded+journaled path", async () => {
    const db = openDatabase(":memory:");
    const q = new SqliteQueue(db, { clock: fixedClock(), maxAttempts: 5 });
    await q.enqueue(mkJob());
    const logs: string[] = [];
    await processLeased(q, (await q.lease(2_100_000))!, STUB_DEPS, {
      logger: { warn: (m) => logs.push(m) },
      runPipeline: run(async () => ({ status: "error", message: "totally novel failure mode", retriable: true })),
    });
    expect(rawRow(db).status).toBe("queued"); // bounded retry, not dead-lettered on the first hit
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("unclassified failure");
    expect(logs[0]).toContain("totally novel failure mode");
  });

  it("redacts credentials (clone-URL token) from the journaled line", async () => {
    const db = openDatabase(":memory:");
    const q = new SqliteQueue(db, { clock: fixedClock(), maxAttempts: 5 });
    await q.enqueue(mkJob());
    const logs: string[] = [];
    // An unknown failure whose message/stack embeds the authenticated clone URL. journalUnclassified
    // dumps the full stack, so without redaction the GitHub token would reach disk.
    const tokenErr = (): Error => {
      const e = new Error(
        "clone failed: 'https://x-access-token:ghs_AbC123secretDEF456@github.com/o/r.git'",
      ) as Error & { status: number };
      e.status = 301; // neither 5xx/429 nor 4xx/auth -> unknown -> journaled
      return e;
    };
    await processLeased(q, (await q.lease(2_100_000))!, STUB_DEPS, {
      logger: { warn: (m) => logs.push(m) },
      runPipeline: run(async () => {
        throw tokenErr();
      }),
    });
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("unclassified failure"); // still journaled for triage
    expect(logs[0]).not.toContain("ghs_AbC123secretDEF456"); // token never reaches the log
    expect(logs[0]).not.toContain("x-access-token:ghs_");
    expect(logs[0]).toContain("***"); // redaction marker
  });
});

describe("drainQueue — resilience", () => {
  it("a thrown pipeline error does not abort the drain; the job is settled", async () => {
    const db = openDatabase(":memory:");
    const q = new SqliteQueue(db, { clock: fixedClock() });
    await q.enqueue(mkJob());

    // Would previously throw out of drainQueue and abort with "drain failed".
    const processed = await drainQueue(q, () => STUB_DEPS, {
      runPipeline: run(async () => {
        throw httpError(502, "Bad Gateway");
      }),
    });
    expect(processed).toBe(1);
    expect(rawRow(db).status).toBe("queued"); // requeued transiently, drain returned cleanly
  });

  it("backstop: a makeDeps failure settles the job instead of aborting the loop", async () => {
    const db = openDatabase(":memory:");
    const q = new SqliteQueue(db, { clock: fixedClock() });
    await q.enqueue(mkJob());

    const processed = await drainQueue(
      q,
      () => {
        throw httpError(503, "Service Unavailable"); // makeDeps itself fails during an outage
      },
      {},
    );
    expect(processed).toBe(1);
    expect(rawRow(db).status).toBe("queued"); // transient -> requeued, not stranded in 'running'
  });
});
