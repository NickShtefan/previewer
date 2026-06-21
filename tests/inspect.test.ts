import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, SqliteStore } from "../src/store";
import type { ReviewRun } from "../src/config";

const T = (s: number): string => `2026-06-22T00:00:0${s}.000Z`;

function run(over: Partial<ReviewRun> & Pick<ReviewRun, "repo" | "prNumber" | "headSha" | "status" | "startedAt">): ReviewRun {
  return {
    id: `${over.repo}#${over.prNumber}@${over.headSha}`,
    runner: "claude-cli",
    model: "claude-opus-4-8",
    profile: "security-baseline",
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    durationMs: 0,
    error: null,
    finishedAt: over.startedAt,
    ...over,
  };
}

let store: SqliteStore;

beforeEach(async () => {
  store = new SqliteStore(openDatabase(":memory:"));
  await store.recordRun(run({ repo: "owner/a", prNumber: 1, headSha: "head-a1", status: "ok", tokensIn: 1000, tokensOut: 100, usd: 0.5, startedAt: T(1) }));
  await store.recordRun(run({ repo: "owner/a", prNumber: 1, headSha: "head-a2", status: "ok", tokensIn: 2000, tokensOut: 200, usd: 1.0, startedAt: T(2) }));
  await store.recordRun(run({ repo: "owner/a", prNumber: 2, headSha: "head-a3", status: "error", tokensIn: 500, tokensOut: 50, usd: 0.2, startedAt: T(3) }));
  await store.recordRun(run({ repo: "owner/b", prNumber: 1, headSha: "head-b1", status: "skipped", startedAt: T(0) }));
});

describe("SqliteStore reporting (inspect)", () => {
  it("aggregateByRepo rolls up counts, tokens, cost; ordered by runs desc", async () => {
    const stats = await store.aggregateByRepo();
    expect(stats.map((s) => s.repo)).toEqual(["owner/a", "owner/b"]);

    const a = stats[0]!;
    expect(a.runs).toBe(3);
    expect(a.ok).toBe(2);
    expect(a.error).toBe(1);
    expect(a.skipped).toBe(0);
    expect(a.tokensIn).toBe(3500);
    expect(a.tokensOut).toBe(350);
    expect(a.usd).toBeCloseTo(1.7, 5);
    expect(a.lastAt).toBe(T(3));

    const b = stats[1]!;
    expect(b.runs).toBe(1);
    expect(b.skipped).toBe(1);
  });

  it("listRuns returns newest-first, filtered by repo, respecting limit", async () => {
    const all = await store.listRuns();
    expect(all).toHaveLength(4);
    expect(all[0]!.headSha).toBe("head-a3"); // T(3) is newest overall

    const a = await store.listRuns({ repo: "owner/a" });
    expect(a.map((r) => r.headSha)).toEqual(["head-a3", "head-a2", "head-a1"]);

    const limited = await store.listRuns({ repo: "owner/a", limit: 2 });
    expect(limited.map((r) => r.headSha)).toEqual(["head-a3", "head-a2"]);
    expect(limited[0]!.runner).toBe("claude-cli");
    expect(limited[0]!.tokensIn).toBe(500);
  });

  it("returns empty results for an unknown repo", async () => {
    expect(await store.listRuns({ repo: "owner/none" })).toEqual([]);
  });
});
