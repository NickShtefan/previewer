/* System / Health status for the LAN dashboard.

   Answers "is the previewer itself healthy?" by reading REAL local sources — the
   per-repo YAML configs, the codex/claude auth files, the gh CLI, and launchd — plus
   the last codex error from the SQLite store. Everything is read-only: no mutations,
   and crucially NO `codex exec` (that would burn the ChatGPT subscription quota).

   Every shell call and filesystem probe is injected (SystemInputs) so it can be faked
   in tests, is time-boxed with a short timeout, and is wrapped in try/catch. A missing
   or slow source degrades to `null` + a disclosing note — /api/system never throws. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { listRepoConfigs } from "../../config";
import type { Db } from "../../store";

/** Per-tracked-repo reviewer config, sliced from config/repos/<dir>/repo.yaml. */
export interface ReviewerConfigRow {
  repo: string;
  enabled: boolean;
  runnerDefault: string;
  /** null = runner's own default model (repo.yaml leaves runner.model empty). */
  runnerModel: string | null;
  runnerReasoningEffort: string | null;
  triggers: string[];
  reviewIncremental: boolean;
  reviewDefaultProfile: string;
}

export interface CodexAuth {
  /** ~/.codex/auth.json present == codex CLI is logged in. We never invoke codex. */
  loggedIn: boolean;
  authPath: string;
  /** Last codex error in the store matched a usage/rate-limit signature. */
  usageLimited: boolean;
  /** Raw last codex error message (so a human can see what it actually was). */
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface ClaudeAuth {
  /** The headless Claude subscription token file the reconciler sources. */
  tokenPresent: boolean;
  tokenPath: string;
}

export interface GithubStatus {
  /** `gh auth token` returned a non-empty token. */
  tokenPresent: boolean;
  rateLimit: { remaining: number; limit: number; reset: number; resetAt: string } | null;
}

export interface ServiceStatus {
  label: string;
  running: boolean;
  pid: number | null;
}

export interface ServicesStatus {
  services: ServiceStatus[];
  /** reconciler.everyHours from platform.yaml; null when unknown. */
  sweepEveryHours: number | null;
}

export interface SystemStatus {
  reviewerConfig: ReviewerConfigRow[];
  engineAuth: { codex: CodexAuth; claude: ClaudeAuth };
  github: GithubStatus;
  services: ServicesStatus;
  updatedAt: string;
  notes: string[];
}

export interface ShellResult {
  ok: boolean;
  stdout: string;
  error?: string;
}
export type ShellRunner = (cmd: string, args: string[], timeoutMs: number) => ShellResult;

/** Everything buildSystem needs, injected so tests can fake shell/fs/db/time. */
export interface SystemInputs {
  reposDir: string;
  sweepEveryHours: number | null;
  /** Read-only store connection, or null if the DB file is not present yet. */
  db: Db | null;
  codexAuthPath: string;
  claudeEnvPath: string;
  runShell: ShellRunner;
  fileExists: (p: string) => boolean;
  now: () => Date;
}

/** launchd jobs the dashboard reports on. */
const SERVICE_LABELS = ["com.nick.previewer-ingress", "com.nick.previewer-reconciler"];

/** Per Kit's spec: treat usage-limit / rate-limit / a bare `exited 1` as usage-limited. */
const CODEX_LIMIT_RE = /usage.?limit|rate.?limit|exited 1/i;

/** Real spawnSync-backed shell runner. Never throws; a failed/timed-out call → ok:false. */
export const realShell: ShellRunner = (cmd, args, timeoutMs) => {
  try {
    const r = spawnSync(cmd, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.error) return { ok: false, stdout: r.stdout ?? "", error: r.error.message };
    return {
      ok: r.status === 0,
      stdout: r.stdout ?? "",
      error: r.status === 0 ? undefined : `exit ${r.status ?? "signal"}`,
    };
  } catch (e) {
    return { ok: false, stdout: "", error: e instanceof Error ? e.message : String(e) };
  }
};

export const realFileExists = (p: string): boolean => existsSync(p);

/** Assemble the full system/health status. Never throws: each source is guarded and
    degrades to null/[] with a disclosing note rather than propagating an error. */
export function buildSystem(io: SystemInputs): SystemStatus {
  const notes: string[] = [];

  const reviewerConfig = readReviewerConfig(io, notes);
  const codex = readCodexAuth(io, notes);
  const claude = readClaudeAuth(io);
  const github = readGithub(io, notes);
  const services = readServices(io, notes);

  return {
    reviewerConfig,
    engineAuth: { codex, claude },
    github,
    services,
    updatedAt: io.now().toISOString(),
    notes,
  };
}

function readReviewerConfig(io: SystemInputs, notes: string[]): ReviewerConfigRow[] {
  try {
    return listRepoConfigs(io.reposDir).map((c) => ({
      repo: c.repo.id,
      enabled: c.repo.enabled,
      runnerDefault: c.runner.default,
      runnerModel: c.runner.model ?? null,
      runnerReasoningEffort: c.runner.reasoningEffort ?? null,
      triggers: c.events.triggers,
      reviewIncremental: c.review.incremental,
      reviewDefaultProfile: c.review.defaultProfile,
    }));
  } catch (e) {
    notes.push(`reviewer config unavailable: ${msg(e)}`);
    return [];
  }
}

function readCodexAuth(io: SystemInputs, notes: string[]): CodexAuth {
  const loggedIn = safeExists(io, io.codexAuthPath);
  let usageLimited = false;
  let lastError: string | null = null;
  let lastErrorAt: string | null = null;

  if (io.db) {
    try {
      if (hasTable(io.db, "review_runs")) {
        const row = io.db
          .prepare(
            `SELECT error, COALESCE(finished_at, started_at) AS at
               FROM review_runs
              WHERE status = 'error' AND error IS NOT NULL
                AND (runner LIKE 'codex%' OR error LIKE '%codex%')
              ORDER BY COALESCE(finished_at, started_at) DESC
              LIMIT 1`,
          )
          .get() as { error: string; at: string } | undefined;
        if (row) {
          lastError = row.error;
          lastErrorAt = row.at;
          usageLimited = CODEX_LIMIT_RE.test(row.error);
        }
      }
    } catch (e) {
      notes.push(`codex last-error unavailable: ${msg(e)}`);
    }
  } else {
    notes.push("codex last-error: store not available yet (usageLimited reported as false).");
  }

  return { loggedIn, authPath: io.codexAuthPath, usageLimited, lastError, lastErrorAt };
}

function readClaudeAuth(io: SystemInputs): ClaudeAuth {
  return { tokenPresent: safeExists(io, io.claudeEnvPath), tokenPath: io.claudeEnvPath };
}

function readGithub(io: SystemInputs, notes: string[]): GithubStatus {
  let tokenPresent = false;
  try {
    const tok = io.runShell("gh", ["auth", "token"], 4000);
    tokenPresent = tok.ok && tok.stdout.trim().length > 0;
    if (!tokenPresent) notes.push("github: gh auth token empty or gh unavailable.");
  } catch (e) {
    notes.push(`github token check failed: ${msg(e)}`);
    return { tokenPresent: false, rateLimit: null };
  }

  if (!tokenPresent) return { tokenPresent: false, rateLimit: null };

  let rateLimit: GithubStatus["rateLimit"] = null;
  try {
    const rl = io.runShell("gh", ["api", "rate_limit"], 6000);
    if (rl.ok) {
      const core = (JSON.parse(rl.stdout) as { resources?: { core?: Record<string, number> } })
        .resources?.core;
      if (core && typeof core.remaining === "number") {
        rateLimit = {
          remaining: core.remaining,
          limit: core.limit,
          reset: core.reset,
          resetAt: new Date(core.reset * 1000).toISOString(),
        };
      } else {
        notes.push("github rate_limit: unexpected payload shape.");
      }
    } else {
      notes.push("github rate_limit unavailable.");
    }
  } catch (e) {
    notes.push(`github rate_limit failed: ${msg(e)}`);
  }

  return { tokenPresent: true, rateLimit };
}

function readServices(io: SystemInputs, notes: string[]): ServicesStatus {
  const byLabel = new Map<string, number | null>();
  try {
    const res = io.runShell("launchctl", ["list"], 4000);
    if (res.ok) {
      // Each line is "PID\tStatus\tLabel"; PID is "-" when the job is loaded but not running.
      for (const line of res.stdout.split("\n")) {
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const pidStr = parts[0].trim();
        byLabel.set(parts[2].trim(), /^\d+$/.test(pidStr) ? Number(pidStr) : null);
      }
    } else {
      notes.push("services: launchctl list unavailable — reporting stopped.");
    }
  } catch (e) {
    notes.push(`services check failed: ${msg(e)}`);
  }

  const services = SERVICE_LABELS.map((label) => {
    const seen = byLabel.has(label);
    const pid = seen ? byLabel.get(label)! : null;
    return { label, running: pid !== null, pid };
  });

  if (io.sweepEveryHours == null) {
    notes.push("services: reconciler sweep interval unknown (reconciler.everyHours absent).");
  }
  return { services, sweepEveryHours: io.sweepEveryHours };
}

function safeExists(io: SystemInputs, p: string): boolean {
  try {
    return io.fileExists(p);
  } catch {
    return false;
  }
}

function hasTable(db: Db, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
  return row !== undefined;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
