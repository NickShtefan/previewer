import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase } from "../src/store";
import type { Db } from "../src/store";
import { buildStatus } from "../src/apps/dashboard/queries";
import { renderPage } from "../src/apps/dashboard/html";

/* The dashboard status is a pure read over the store, so we seed a real in-memory
   DB (the same schema the orchestrator writes) rather than mocking. */

const T = (h: number, m = 0): string =>
  `2026-07-10T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

const NOW = () => new Date("2026-07-10T12:00:00.000Z");

function insertRun(db: Db, r: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO review_runs
       (id, repo, pr_number, head_sha, base_sha, runner, model, reasoning_effort, profile,
        status, comment_id, tokens_in, tokens_out, usd, duration_ms, error, started_at, finished_at)
     VALUES
       (@id, @repo, @pr, @sha, NULL, @runner, @model, @effort, NULL,
        @status, @commentId, 0, 0, 0, 0, @error, @started, @finished)`,
  ).run({
    id: `${r.repo}#${r.pr}@${r.sha}`,
    repo: r.repo,
    pr: r.pr,
    sha: r.sha,
    runner: r.runner ?? null,
    model: r.model ?? null,
    effort: r.effort ?? null,
    status: r.status,
    commentId: r.commentId ?? null,
    error: r.error ?? null,
    started: r.started,
    finished: r.finished ?? null,
  });
}

function insertJob(db: Db, r: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO jobs
       (id, repo, pr_number, head_sha, base_sha, source, status, attempts, lease_id, locked_at, visible_at, created_at)
     VALUES (@id, @repo, @pr, @sha, NULL, @source, @status, @attempts, NULL, NULL, @vis, @created)`,
  ).run({
    id: `job:${r.repo}#${r.pr}@${r.sha}`,
    repo: r.repo,
    pr: r.pr,
    sha: r.sha,
    source: r.source ?? "webhook",
    status: r.status,
    attempts: r.attempts ?? 0,
    vis: r.vis ?? T(11),
    created: r.created ?? T(11),
  });
}

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");

  // owner/a #1 — two finalized rounds; latest is ok with a posted comment.
  insertRun(db, { repo: "owner/a", pr: 1, sha: "aaa11111", runner: "codex-cli", model: "gpt-5.6-sol", effort: "max", status: "ok", commentId: 100, started: T(9), finished: T(9, 5) });
  insertRun(db, { repo: "owner/a", pr: 1, sha: "aaa22222", runner: "codex-cli", model: "gpt-5.6-sol", effort: "max", status: "ok", commentId: 101, started: T(10), finished: T(10, 5) });

  // owner/b #2 — a rate-limited error round.
  insertRun(db, { repo: "owner/b", pr: 2, sha: "bbb33333", runner: "codex-cli", model: "gpt-5.6-sol", status: "error", error: "codex exited: subscription_rate_limits reached", started: T(8), finished: T(8, 1) });

  // owner/b #2 — an in-flight review (placeholder row, runner/model still null).
  insertRun(db, { repo: "owner/b", pr: 2, sha: "bbb44444", status: "running", started: T(11, 58) });

  // Queue snapshot.
  insertJob(db, { repo: "owner/b", pr: 2, sha: "bbb44444", status: "running", source: "reconciler", attempts: 1 });
  insertJob(db, { repo: "owner/c", pr: 3, sha: "ccc55555", status: "queued" });
  insertJob(db, { repo: "owner/a", pr: 1, sha: "aaa22222", status: "done" });
  insertJob(db, { repo: "owner/b", pr: 2, sha: "bbb33333", status: "dead_letter" });
});

describe("dashboard buildStatus", () => {
  it("reports in-flight reviews with queue enrichment and null engine", () => {
    const s = buildStatus(db, NOW);
    expect(s.reviewers).toHaveLength(1);
    const r = s.reviewers[0]!;
    expect(r.repo).toBe("owner/b");
    expect(r.prNumber).toBe(2);
    expect(r.headSha).toBe("bbb44444");
    expect(r.runner).toBeNull(); // not written until the run finalizes
    expect(r.model).toBeNull();
    expect(r.source).toBe("reconciler"); // joined from the leased job
    expect(r.attempts).toBe(1);
    expect(r.stale).toBe(false); // started 2 min ago, under the 15-min window
    expect(r.ageSeconds).toBe(120);
  });

  it("rolls up PRs: rounds, posted count, latest verdict and engine", () => {
    const s = buildStatus(db, NOW);
    const a = s.prs.find((p) => p.repo === "owner/a" && p.prNumber === 1)!;
    expect(a.rounds).toBe(2);
    expect(a.posted).toBe(2);
    expect(a.headSha).toBe("aaa22222"); // latest
    expect(a.lastStatus).toBe("ok");
    expect(a.lastRunner).toBe("codex-cli");
    expect(a.lastModel).toBe("gpt-5.6-sol");
    expect(a.lastReasoningEffort).toBe("max");
    expect(a.findingsBySeverity).toBeNull(); // never persisted by the store

    const b = s.prs.find((p) => p.repo === "owner/b" && p.prNumber === 2)!;
    expect(b.rounds).toBe(1); // running placeholder is excluded from finalized rounds
    expect(b.posted).toBe(0);
    expect(b.lastStatus).toBe("error");
  });

  it("counts the queue by status", () => {
    const q = buildStatus(db, NOW).queue;
    expect(q.enqueued).toBe(1);
    expect(q.inFlight).toBe(1);
    expect(q.done).toBe(1);
    expect(q.deadLetter).toBe(1);
    expect(q.error).toBe(0);
  });

  it("surfaces recent errors and classifies rate limits", () => {
    const errs = buildStatus(db, NOW).queue.recentErrors;
    expect(errs).toHaveLength(1);
    expect(errs[0]!.kind).toBe("rate_limit");
    expect(errs[0]!.repo).toBe("owner/b");
  });

  it("classifies usage-limit errors distinctly from rate limits", () => {
    insertRun(db, { repo: "owner/d", pr: 4, sha: "ddd66666", runner: "codex-cli", model: "gpt-5.6-sol", status: "error", error: "You've hit your usage limit. Try again at 3:30 AM.", started: T(7), finished: T(7, 1) });
    const errs = buildStatus(db, NOW).queue.recentErrors;
    const usage = errs.find((e) => e.repo === "owner/d")!;
    expect(usage.kind).toBe("usage_limit");
    const rate = errs.find((e) => e.repo === "owner/b")!;
    expect(rate.kind).toBe("rate_limit");
  });

  it("passes the full multi-line error text through untruncated", () => {
    const full = "codex exited 1: fatal: rate limit exceeded (429)\n\nstderr:\nfatal: rate limit exceeded (429)";
    insertRun(db, { repo: "owner/e", pr: 5, sha: "eee77777", runner: "codex-cli", model: "gpt-5.6-sol", status: "error", error: full, started: T(6), finished: T(6, 1) });
    const errs = buildStatus(db, NOW).queue.recentErrors;
    const e = errs.find((x) => x.repo === "owner/e")!;
    expect(e.error).toBe(full);
    expect(e.error).toContain("\n"); // newlines survive so the display can pre-wrap them
    expect(e.kind).toBe("rate_limit");
  });

  it("always discloses what the store does not persist", () => {
    const notes = buildStatus(db, NOW).notes.join(" ");
    expect(notes).toMatch(/Findings-by-severity/i);
  });
});

describe("dashboard html", () => {
  it("ships the expandable-error and usage/rate-limit badge markup", () => {
    const html = renderPage();
    // Badge variants for both limit kinds.
    expect(html).toContain(".badge.usage_limit");
    expect(html).toContain(".badge.rate_limit");
    // Expandable long errors + newline-preserving message box.
    expect(html).toContain("err-details");
    expect(html).toContain("<details");
    expect(html).toContain("white-space: pre-wrap");
    // Distinct human labels for each kind.
    expect(html).toContain("usage limit");
    expect(html).toContain("rate limit");
  });

  it("renders the RESOLVED (profile-aware) engine, not the raw runner.default", () => {
    const html = renderPage();
    // ENGINE + Monitored repos read the resolved client and the active profile name...
    expect(html).toContain("cfg.resolvedRunner");
    expect(html).toContain("cfg.resolvedModel");
    expect(html).toContain("c.resolvedRunner");
    // ...and never the raw inline runner.default in those panels.
    expect(html).not.toContain("cfg.runnerDefault");
    expect(html).not.toContain("c.runnerDefault");
  });

  it("renders the CONCISE codex status in AUTH, not the full lastError wall of text", () => {
    const html = renderPage();
    // AUTH shows the one-line summary...
    expect(html).toContain("codex.lastErrorSummary");
    // ...and does not dump the full raw codex error there.
    expect(html).not.toContain("esc(codex.lastError)");
  });
});
