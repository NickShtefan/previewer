import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ContextProvider } from "../core";
import { ConfigError } from "../core";
import type { ContextPack, ResolvedContext, ChangedFile } from "../config";
import { loadPack } from "./pack";
import { resolveContext } from "./routing";

/** Loads packs from `config/repos/<owner>__<name>/context-pack/` and caches them. */
export class FsContextProvider implements ContextProvider {
  private readonly cache = new Map<string, ContextPack>();

  constructor(private readonly reposDir: string) {}

  private packDir(repo: string): string {
    return join(this.reposDir, repo.replace("/", "__"), "context-pack");
  }

  async getPack(repo: string): Promise<ContextPack | null> {
    const cached = this.cache.get(repo);
    if (cached) return cached;
    const dir = this.packDir(repo);
    if (!existsSync(dir)) return null;
    const pack = loadPack(dir, repo);
    this.cache.set(repo, pack);
    return pack;
  }

  async resolve(repo: string, changed: ChangedFile[]): Promise<ResolvedContext> {
    const pack = await this.getPack(repo);
    if (!pack) throw new ConfigError(`No context pack found for ${repo}`);
    return resolveContext(pack, changed);
  }
}
