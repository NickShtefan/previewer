import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFiles, discoverContext, buildInventory } from "../src/context";

/**
 * Regression guard: onboarding a repo whose checkout also holds the previewer's
 * own runtime tree (`data/` — the SQLite DB + cloned PR workspaces under
 * `data/workspaces/<owner>__<repo>/`) must NOT ingest those runtime checkouts.
 * Before the fix, self-onboarding walked into `data/workspaces/…/AGENTS.md` and
 * emitted the runtime kourion checkout's guides as previewer subsystems (and its
 * top dirs as modules), which is why the first self-onboard shipped with its
 * subsystems stripped.
 */
async function seedRepoWithRuntimeData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "previewer-data-excl-"));

  // The real repo source.
  await writeFile(join(dir, "AGENTS.md"), "# Root Guide\n\nApplies to the whole repo.\n");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");

  // The previewer's own runtime tree: a cloned PR workspace with ITS OWN AGENTS
  // hierarchy plus SQLite files. None of this is the onboarded repo's source.
  await mkdir(join(dir, "data", "workspaces", "NickShtefan__kourion.fi", "api"), { recursive: true });
  await writeFile(join(dir, "data", "orchestrator.db"), "sqlite");
  await writeFile(join(dir, "data", "workspaces", "NickShtefan__kourion.fi", "AGENTS.md"), "# Kourion Root\n");
  await writeFile(join(dir, "data", "workspaces", "NickShtefan__kourion.fi", "api", "AGENTS.md"), "# Kourion API\n");
  await writeFile(join(dir, "data", "workspaces", "NickShtefan__kourion.fi", "api", "server.ts"), "export const app = {};\n");

  return dir;
}

let repoDir: string;
beforeEach(async () => {
  repoDir = await seedRepoWithRuntimeData();
});
afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("onboarding excludes the runtime data/ tree", () => {
  it("walkFiles never descends into data/", () => {
    const files = walkFiles(repoDir);
    expect(files).toContain("AGENTS.md");
    expect(files).toContain("src/index.ts");
    expect(files.some((f) => f.startsWith("data/"))).toBe(false);
  });

  it("discover keeps the root guide but ingests no data/** AGENTS.md as a subsystem", () => {
    const d = discoverContext(repoDir);
    expect(d.rootAgents?.path).toBe("AGENTS.md"); // real root guide still found
    expect(d.nestedAgents).toEqual([]); // the two data/** AGENTS.md are NOT subsystems
    expect(d.found.some((f) => f.path.startsWith("data/"))).toBe(false);
  });

  it("inventory never surfaces data/ as a module", () => {
    const inv = buildInventory(repoDir);
    expect(inv.modules.map((m) => m.name)).not.toContain("data");
  });
});
