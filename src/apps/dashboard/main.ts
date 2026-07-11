/* Read-only LAN dashboard for previewer.

   Serves a single-page status view of the review orchestrator by reading the
   existing SQLite store (jobs + review_runs) — no writes, no GitHub token, no auth.
   Binds 0.0.0.0 so it is reachable from the local network. The webhook ingress owns
   8787; this defaults to 8788 (override with DASHBOARD_PORT).

     DASHBOARD_PORT=8788 npm run dashboard

   Run it from the repo root so ./config/platform.yaml and the configured dbPath
   (default ./data/orchestrator.db) resolve the same way the CLI/ingress see them. */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadPlatformConfig } from "../../config";
import type { Db } from "../../store";
import { buildStatus, type DashboardStatus } from "./queries";
import {
  buildSystem,
  realShell,
  realFileExists,
  type SystemStatus,
} from "./system";
import { renderPage } from "./html";

/** Lazily open a single read-only connection; retry on the next request until the
    DB file exists (the orchestrator may not have created it yet). */
function makeDbProvider(dbPath: string): () => Db | null {
  let db: Db | null = null;
  return () => {
    if (db) return db;
    if (!existsSync(dbPath)) return null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma("busy_timeout = 5000");
      return db;
    } catch {
      return null; // e.g. file appeared mid-write; try again next poll
    }
  };
}

function emptyStatus(note: string): DashboardStatus {
  return {
    reviewers: [],
    prs: [],
    queue: { enqueued: 0, inFlight: 0, done: 0, skipped: 0, error: 0, deadLetter: 0, recentErrors: [] },
    updatedAt: new Date().toISOString(),
    notes: [note],
  };
}

function emptySystem(note: string): SystemStatus {
  return {
    reviewerConfig: [],
    engineAuth: {
      codex: { loggedIn: false, authPath: "", usageLimited: false, lastError: null, lastErrorAt: null },
      claude: { tokenPresent: false, tokenPath: "" },
    },
    github: { tokenPresent: false, rateLimit: null },
    services: { services: [], sweepEveryHours: null },
    updatedAt: new Date().toISOString(),
    notes: [note],
  };
}

async function main(): Promise<void> {
  const platformPath = existsSync("./config/platform.yaml")
    ? "./config/platform.yaml"
    : "./config/platform.example.yaml";
  const platform = loadPlatformConfig(platformPath);
  const dbPath = platform.dbPath;
  const reposDir = platform.reposDir;
  const sweepEveryHours = platform.reconciler.everyHours;
  const home = homedir();
  const codexAuthPath = join(home, ".codex", "auth.json");
  const claudeEnvPath = join(home, ".config", "previewer", "claude.env");
  const port = Number(process.env.DASHBOARD_PORT ?? 8788);
  const getDb = makeDbProvider(dbPath);

  const page = renderPage();

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" }).end("method not allowed");
      return;
    }

    if (url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }

    if (url === "/api/status") {
      let status: DashboardStatus;
      try {
        const db = getDb();
        status = db
          ? buildStatus(db)
          : emptyStatus(`Store not found at ${dbPath} yet — run a review or start the orchestrator.`);
      } catch (e) {
        status = emptyStatus(`Failed to read store: ${e instanceof Error ? e.message : String(e)}`);
      }
      res
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify(status));
      return;
    }

    if (url === "/api/system") {
      let sys: SystemStatus;
      try {
        sys = buildSystem({
          reposDir,
          sweepEveryHours,
          db: getDb(),
          codexAuthPath,
          claudeEnvPath,
          runShell: realShell,
          fileExists: realFileExists,
          now: () => new Date(),
        });
      } catch (e) {
        // buildSystem is defensive internally, but never let /api/system 500.
        sys = emptySystem(`Failed to build system status: ${e instanceof Error ? e.message : String(e)}`);
      }
      res
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify(sys));
      return;
    }

    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });

  // 0.0.0.0 — reachable from the local network, no auth (LAN-only by design).
  server.listen(port, "0.0.0.0", () => {
    console.log(`previewer dashboard on http://0.0.0.0:${port}  (LAN: http://<this-host-ip>:${port})`);
    console.log(`reading store: ${dbPath}${existsSync(dbPath) ? "" : " (not present yet)"}`);
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
