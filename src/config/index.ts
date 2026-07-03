import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { PlatformConfig, RepoConfig } from "./schema";
import type { PlatformConfig as PlatformConfigT, RepoConfig as RepoConfigT } from "./schema";

export function loadPlatformConfig(path = "./config/platform.yaml"): PlatformConfigT {
  const raw: unknown = existsSync(path) ? parseYaml(readFileSync(path, "utf8")) : {};
  const cfg = PlatformConfig.parse(raw ?? {});
  // Resolve filesystem paths to ABSOLUTE. The default `workspacesDir` is relative
  // (`./data/workspaces`), and the codex-cli runner passes it as BOTH the child cwd
  // and `codex exec -C <dir>`; a relative value there is resolved twice (cwd already
  // IS the dir) → a doubled, nonexistent path → `codex exited 1: No such file or
  // directory (os error 2)`. Absolute paths make `-C` cwd-independent and are safer
  // for every consumer. Resolution is relative to the process CWD.
  return {
    ...cfg,
    dataDir: resolve(cfg.dataDir),
    dbPath: resolve(cfg.dbPath),
    reposDir: resolve(cfg.reposDir),
    workspacesDir: resolve(cfg.workspacesDir),
  };
}

export function loadRepoConfig(path: string): RepoConfigT {
  const raw: unknown = parseYaml(readFileSync(path, "utf8"));
  return RepoConfig.parse(raw);
}

/** Load every `config/repos/<dir>/repo.yaml` into validated configs. */
export function listRepoConfigs(reposDir: string): RepoConfigT[] {
  if (!existsSync(reposDir)) return [];
  const out: RepoConfigT[] = [];
  for (const entry of readdirSync(reposDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue; // `_example` = template
    const p = join(reposDir, entry.name, "repo.yaml");
    if (existsSync(p)) out.push(loadRepoConfig(p));
  }
  return out;
}

export * from "./schema";
