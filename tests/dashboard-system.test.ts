import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/store";
import type { Db } from "../src/store";
import { DEFAULT_RUNNER_PROFILES } from "../src/config";
import { buildSystem, type ShellRunner, type SystemInputs } from "../src/apps/dashboard/system";

/* buildSystem reads real local sources (repo YAMLs, auth files, gh, launchctl, store).
   All of those are injected, so here we seed an in-memory store + a temp reposDir and
   fake the shell / fs to exercise every branch without touching the real machine. */

const NOW = () => new Date("2026-07-11T12:00:00.000Z");

function insertErr(db: Db, r: { repo: string; pr: number; sha: string; runner: string | null; error: string; at: string }): void {
  db.prepare(
    `INSERT INTO review_runs
       (id, repo, pr_number, head_sha, base_sha, runner, model, reasoning_effort, profile,
        status, comment_id, tokens_in, tokens_out, usd, duration_ms, error, started_at, finished_at)
     VALUES (@id, @repo, @pr, @sha, NULL, @runner, NULL, NULL, NULL,
        'error', NULL, 0, 0, 0, 0, @error, @at, @at)`,
  ).run({ id: `${r.repo}#${r.pr}@${r.sha}`, repo: r.repo, pr: r.pr, sha: r.sha, runner: r.runner, error: r.error, at: r.at });
}

/** A launchctl-list style shell + gh stub. Toggle behaviours via the flags. */
function fakeShell(opts: {
  ghToken?: string;
  ghRate?: { remaining: number; limit: number; reset: number };
  ingressPid?: number | "-";
  reconcilerPid?: number | "-";
  launchctlFails?: boolean;
}): ShellRunner {
  return (cmd, args) => {
    if (cmd === "gh" && args[0] === "auth") {
      return { ok: opts.ghToken != null, stdout: opts.ghToken ?? "" };
    }
    if (cmd === "gh" && args[0] === "api") {
      if (!opts.ghRate) return { ok: false, stdout: "" };
      return { ok: true, stdout: JSON.stringify({ resources: { core: opts.ghRate } }) };
    }
    if (cmd === "launchctl") {
      if (opts.launchctlFails) return { ok: false, stdout: "", error: "boom" };
      const ing = opts.ingressPid ?? 111;
      const rec = opts.reconcilerPid ?? 222;
      const lines = [
        "PID\tStatus\tLabel",
        `${ing}\t0\tcom.nick.previewer-ingress`,
        `${rec}\t0\tcom.nick.previewer-reconciler`,
        "-\t0\tcom.apple.other",
      ];
      return { ok: true, stdout: lines.join("\n") };
    }
    return { ok: false, stdout: "" };
  };
}

let db: Db;
let reposDir: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  reposDir = mkdtempSync(join(tmpdir(), "previewer-repos-"));
  const dir = join(reposDir, "NickShtefan__kourion.fi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "repo.yaml"),
    [
      "repo:",
      "  id: NickShtefan/kourion.fi",
      "  enabled: true",
      "events:",
      "  triggers: [opened, synchronize]",
      "review:",
      "  defaultProfile: security-baseline",
      "  incremental: true",
      "runner:",
      "  default: codex-cli",
      "  model: gpt-5.6-sol",
      "  reasoningEffort: max",
      "",
    ].join("\n"),
  );
  // `_example` must be ignored by the loader.
  const ex = join(reposDir, "_example");
  mkdirSync(ex, { recursive: true });
  writeFileSync(join(ex, "repo.yaml"), "repo:\n  id: owner/ignored\n");
});

afterEach(() => {
  rmSync(reposDir, { recursive: true, force: true });
});

function inputs(over: Partial<SystemInputs> = {}): SystemInputs {
  return {
    reposDir,
    runnerProfiles: DEFAULT_RUNNER_PROFILES,
    sweepEveryHours: 1,
    db,
    codexAuthPath: "/fake/.codex/auth.json",
    claudeEnvPath: "/fake/claude.env",
    runShell: fakeShell({ ghToken: "tok", ghRate: { remaining: 4990, limit: 5000, reset: 1783733658 } }),
    fileExists: () => true,
    now: NOW,
    ...over,
  };
}

describe("dashboard buildSystem", () => {
  it("slices reviewer config from repo.yaml and ignores _example", () => {
    const s = buildSystem(inputs());
    expect(s.reviewerConfig).toHaveLength(1);
    const c = s.reviewerConfig[0]!;
    expect(c.repo).toBe("NickShtefan/kourion.fi");
    expect(c.enabled).toBe(true);
    expect(c.runnerDefault).toBe("codex-cli");
    expect(c.runnerModel).toBe("gpt-5.6-sol");
    expect(c.runnerReasoningEffort).toBe("max");
    expect(c.reviewDefaultProfile).toBe("security-baseline");
    expect(c.triggers).toEqual(["opened", "synchronize"]);
  });

  it("resolves a repo still on the inline runner block to that same inline client (no profile)", () => {
    const c = buildSystem(inputs()).reviewerConfig[0]!;
    // Inline config: resolved == inline, and no active profile name.
    expect(c.resolvedRunner).toBe("codex-cli");
    expect(c.resolvedModel).toBe("gpt-5.6-sol");
    expect(c.resolvedEffort).toBe("max");
    expect(c.profile).toBeNull();
  });

  it("resolves the ACTIVE profile (not the raw runner.default) for a profile-driven repo", () => {
    // A repo that selects a client via `runner.profile` leaves runner.default at the schema fallback
    // ("anthropic-api"). The ENGINE panel must show the resolved client (claude-cli / claude-fable-5),
    // not that fallback. This is Bug 1.
    const dir = join(reposDir, "NickShtefan__stonksnws");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "repo.yaml"),
      ["repo:", "  id: NickShtefan/stonksnws", "runner:", "  profile: fable-max", ""].join("\n"),
    );
    const rows = buildSystem(inputs()).reviewerConfig;
    const c = rows.find((r) => r.repo === "NickShtefan/stonksnws")!;
    expect(c.runnerDefault).toBe("anthropic-api"); // raw inline fallback (the wrong value the bug showed)
    expect(c.resolvedRunner).toBe("claude-cli"); // effective client from the profile
    expect(c.resolvedModel).toBe("claude-fable-5");
    expect(c.resolvedEffort).toBe("max");
    expect(c.profile).toBe("fable-max");
  });

  it("degrades an unknown profile to the inline runner + a disclosing note (never blanks the panel)", () => {
    const dir = join(reposDir, "NickShtefan__ghost");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "repo.yaml"),
      ["repo:", "  id: NickShtefan/ghost", "runner:", "  profile: does-not-exist", ""].join("\n"),
    );
    const s = buildSystem(inputs());
    // The good repo still resolves; the bad one falls back to the inline default.
    expect(s.reviewerConfig).toHaveLength(2);
    const ghost = s.reviewerConfig.find((r) => r.repo === "NickShtefan/ghost")!;
    expect(ghost.resolvedRunner).toBe("anthropic-api"); // inline fallback
    expect(ghost.profile).toBeNull();
    expect(s.notes.join(" ")).toMatch(/runner profile for NickShtefan\/ghost unresolved/);
  });

  it("does NOT flag a bare codex 'exited 1' as usage-limited, but still surfaces lastError", () => {
    // A launch failure ('exited 1: Reading prompt from stdin') is not a billing block.
    insertErr(db, { repo: "NickShtefan/kourion.fi", pr: 5, sha: "deadbeef", runner: "codex-cli", error: "codex exited 1: Reading prompt from stdin...", at: "2026-07-11T00:25:27.704Z" });
    const s = buildSystem(inputs());
    expect(s.engineAuth.codex.usageLimited).toBe(false);
    expect(s.engineAuth.codex.lastError).toMatch(/exited 1/);
    expect(s.engineAuth.codex.lastErrorAt).toBe("2026-07-11T00:25:27.704Z");
    expect(s.engineAuth.codex.loggedIn).toBe(true); // fileExists() => true
  });

  it("flags a genuine codex usage-limit store error as usage-limited", () => {
    insertErr(db, { repo: "NickShtefan/kourion.fi", pr: 7, sha: "beefcafe", runner: "codex-cli", error: "You've hit your usage limit. Try again at 3:30 AM.", at: "2026-07-11T00:25:27.704Z" });
    const s = buildSystem(inputs());
    expect(s.engineAuth.codex.usageLimited).toBe(true);
    expect(s.engineAuth.codex.lastError).toMatch(/usage limit/i);
  });

  it("condenses a usage-limit error to a one-line 'retry after <time>' summary (Bug 2)", () => {
    insertErr(db, { repo: "NickShtefan/kourion.fi", pr: 7, sha: "beefcafe", runner: "codex-cli", error: "You've hit your usage limit. Try again at 3:30 AM.", at: "2026-07-11T00:25:27.704Z" });
    const codex = buildSystem(inputs()).engineAuth.codex;
    expect(codex.lastErrorSummary).toBe("usage limit - retry after 3:30 AM");
  });

  it("condenses a codex wall-of-text error to a single headline line, not the whole dump (Bug 2)", () => {
    // Shape produced by describeCliFailure: a headline, then the labelled two-stream body.
    const wall = [
      "codex exited 1: stream error: 429 Too Many Requests",
      "",
      "stdout:",
      "loading context...",
      "still working...",
      "",
      "stderr:",
      "Reading prompt from stdin...",
      "stream error: 429 Too Many Requests",
    ].join("\n");
    insertErr(db, { repo: "NickShtefan/kourion.fi", pr: 8, sha: "d00dfeed", runner: "codex-cli", error: wall, at: "2026-07-11T01:00:00.000Z" });
    const codex = buildSystem(inputs()).engineAuth.codex;
    // Full text is preserved on lastError (RECENT ERRORS renders that), but the AUTH summary is one line.
    expect(codex.lastError).toBe(wall);
    expect(codex.lastErrorSummary).toBe("codex exited 1: stream error: 429 Too Many Requests");
    expect(codex.lastErrorSummary).not.toContain("\n");
    expect(codex.lastErrorSummary!.length).toBeLessThan(wall.length);
  });

  it("leaves lastErrorSummary null when there is no codex error", () => {
    expect(buildSystem(inputs()).engineAuth.codex.lastErrorSummary).toBeNull();
  });

  it("does not flag usage-limited when the last codex error is unrelated", () => {
    insertErr(db, { repo: "NickShtefan/kourion.fi", pr: 6, sha: "cafe", runner: "codex-cli", error: "no parseable JSON object found in model output", at: "2026-07-05T23:54:56.476Z" });
    const s = buildSystem(inputs());
    expect(s.engineAuth.codex.usageLimited).toBe(false);
    expect(s.engineAuth.codex.lastError).toMatch(/no parseable JSON/);
  });

  it("reports github token + core rate limit", () => {
    const s = buildSystem(inputs());
    expect(s.github.tokenPresent).toBe(true);
    expect(s.github.rateLimit).not.toBeNull();
    expect(s.github.rateLimit!.remaining).toBe(4990);
    expect(s.github.rateLimit!.limit).toBe(5000);
    expect(s.github.rateLimit!.resetAt).toBe(new Date(1783733658 * 1000).toISOString());
  });

  it("degrades github to tokenPresent:false without throwing when gh is absent", () => {
    const s = buildSystem(inputs({ runShell: fakeShell({}) }));
    expect(s.github.tokenPresent).toBe(false);
    expect(s.github.rateLimit).toBeNull();
    expect(s.notes.join(" ")).toMatch(/gh auth token empty/);
  });

  it("maps launchd services to running(pid) / stopped and carries the sweep interval", () => {
    const s = buildSystem(inputs({ runShell: fakeShell({ ghToken: "t", ingressPid: 63912, reconcilerPid: "-" }) }));
    const ing = s.services.services.find((x) => x.label.endsWith("ingress"))!;
    const rec = s.services.services.find((x) => x.label.endsWith("reconciler"))!;
    expect(ing.running).toBe(true);
    expect(ing.pid).toBe(63912);
    expect(rec.running).toBe(false); // PID column was "-"
    expect(rec.pid).toBeNull();
    expect(s.services.sweepEveryHours).toBe(1);
  });

  it("never throws when launchctl fails — reports services stopped with a note", () => {
    const s = buildSystem(inputs({ runShell: fakeShell({ ghToken: "t", launchctlFails: true }) }));
    expect(s.services.services.every((x) => !x.running)).toBe(true);
    expect(s.notes.join(" ")).toMatch(/launchctl list unavailable/);
  });

  it("handles a null store (DB not present) without throwing", () => {
    const s = buildSystem(inputs({ db: null }));
    expect(s.engineAuth.codex.usageLimited).toBe(false);
    expect(s.engineAuth.codex.lastError).toBeNull();
    expect(s.notes.join(" ")).toMatch(/store not available/);
  });

  it("reports auth files absent when fileExists is false", () => {
    const s = buildSystem(inputs({ fileExists: () => false }));
    expect(s.engineAuth.codex.loggedIn).toBe(false);
    expect(s.engineAuth.claude.tokenPresent).toBe(false);
  });
});
