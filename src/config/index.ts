import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PlatformConfig, RepoConfig } from "./schema";
import type { PlatformConfig as PlatformConfigT, RepoConfig as RepoConfigT } from "./schema";

export function loadPlatformConfig(path = "./config/platform.yaml"): PlatformConfigT {
  const raw: unknown = existsSync(path) ? parseYaml(readFileSync(path, "utf8")) : {};
  return PlatformConfig.parse(raw ?? {});
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
