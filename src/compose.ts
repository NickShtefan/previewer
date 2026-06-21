import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { Octokit } from "@octokit/rest";
import { loadPlatformConfig, loadRepoConfig, listRepoConfigs } from "./config";
import type { RepoConfig, PlatformConfig } from "./config";
import { ConfigError } from "./core";
import type { Publisher, GitHubClient, ContextProvider, RunnerRegistry } from "./core";
import { createStores } from "./store";
import type { Db, SqliteStore, SqliteQueue } from "./store";
import { FsContextProvider, OnboardingPipeline } from "./context";
import type { PackGenerator } from "./core";
import {
  DefaultRunnerRegistry,
  ClaudeCliRunner,
  CodexCliRunner,
  AnthropicApiRunner,
  ClaudeCliPackGenerator,
  CodexPackGenerator,
} from "./runners";
import { GithubGateway, SingleCommentPublisher, ManualPullSource } from "./github";
import { octokitPullsApi, octokitIssueCommentsApi } from "./github/app";
import { CacheWorkspaceProvider, LocalWorktreeProvider } from "./apps/worker/workspace";
import type { WorkspaceProvider } from "./apps/worker/workspace";
import type { PipelineDeps } from "./apps/worker/pipeline";
import { createLogger } from "./telemetry";
import type { Logger } from "./telemetry";

export interface ReviewWiringOptions {
  prNumber: number;
  dryRun?: boolean;
  local?: string; // local checkout path -> non-destructive worktree, offline
  head?: string; // explicit head sha -> ManualPullSource, no GitHub API
  base?: string;
  token?: string; // GitHub PAT for API + clone + publish
}

const noopPublisher: Publisher = {
  async upsertReviewComment() {
    throw new Error("publishing is disabled in dry-run");
  },
};

/** Build the dependency graph for a single review (CLI path). */
export function composeReviewDeps(repoId: string, opts: ReviewWiringOptions): { deps: PipelineDeps; db: Db } {
  const platformPath = existsSync("./config/platform.yaml")
    ? "./config/platform.yaml"
    : "./config/platform.example.yaml";
  const platform = loadPlatformConfig(platformPath);
  mkdirSync(dirname(platform.dbPath), { recursive: true });
  mkdirSync(platform.workspacesDir, { recursive: true });

  const repoConfig = loadRepoConfigFor(platform.reposDir, repoId);
  const { db, store } = createStores(platform.dbPath);
  const context = new FsContextProvider(platform.reposDir);
  const logger = createLogger("review", platform.logLevel);

  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  let octokit: Octokit | undefined;
  const getOctokit = (): Octokit => {
    if (!octokit) {
      if (!token) {
        throw new ConfigError(
          "GitHub access needed: pass --token or set GITHUB_TOKEN " +
            "(or use --local --head <sha> for a fully offline dry-run).",
        );
      }
      octokit = new Octokit({ auth: token });
    }
    return octokit;
  };
  const workspaceDir = (repo: string): string => join(platform.workspacesDir, repo.replace("/", "__"));
  const cloneUrl = (repo: string): string =>
    token ? `https://x-access-token:${token}@github.com/${repo}.git` : `https://github.com/${repo}.git`;

  const github: GitHubClient = opts.head
    ? new ManualPullSource({
        prNumber: opts.prNumber,
        headSha: opts.head,
        baseSha: opts.base ?? repoConfig.repo.defaultBranch,
      })
    : new GithubGateway({ pulls: octokitPullsApi(getOctokit()), cloneUrl, workspaceDir });

  const workspace: WorkspaceProvider = opts.local
    ? new LocalWorktreeProvider(opts.local)
    : new CacheWorkspaceProvider(cloneUrl, workspaceDir);

  const publisher: Publisher = opts.dryRun
    ? noopPublisher
    : new SingleCommentPublisher(octokitIssueCommentsApi(getOctokit()));

  const runners = new DefaultRunnerRegistry();
  runners.register(new ClaudeCliRunner());
  runners.register(new CodexCliRunner());
  runners.register(new AnthropicApiRunner());

  const deps: PipelineDeps = {
    store,
    github,
    workspace,
    context,
    runners,
    publisher,
    repoConfig,
    logger,
    language: platform.defaultLanguage,
  };
  return { deps, db };
}

export interface Platform {
  platform: PlatformConfig;
  db: Db;
  store: SqliteStore;
  queue: SqliteQueue;
  github: GitHubClient;
  context: ContextProvider;
  runners: RunnerRegistry;
  publisher: Publisher;
  workspace: WorkspaceProvider;
  logger: Logger;
  repoConfigs: RepoConfig[];
  pipelineDepsFor(repoId: string): PipelineDeps;
}

/** Shared platform infra + a per-repo PipelineDeps factory (reconciler / worker path). */
export function composePlatform(opts: { token?: string } = {}): Platform {
  const platformPath = existsSync("./config/platform.yaml")
    ? "./config/platform.yaml"
    : "./config/platform.example.yaml";
  const platform = loadPlatformConfig(platformPath);
  mkdirSync(dirname(platform.dbPath), { recursive: true });
  mkdirSync(platform.workspacesDir, { recursive: true });

  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new ConfigError("GitHub access needed: set GITHUB_TOKEN or pass --token.");
  const octokit = new Octokit({ auth: token });

  const { db, store, queue } = createStores(platform.dbPath);
  const context = new FsContextProvider(platform.reposDir);
  const logger = createLogger("platform", platform.logLevel);
  const repoConfigs = listRepoConfigs(platform.reposDir).filter((c) => c.repo.enabled);

  const workspaceDir = (repo: string): string => join(platform.workspacesDir, repo.replace("/", "__"));
  const cloneUrl = (repo: string): string => `https://x-access-token:${token}@github.com/${repo}.git`;

  const github = new GithubGateway({ pulls: octokitPullsApi(octokit), cloneUrl, workspaceDir });
  const publisher: Publisher = new SingleCommentPublisher(octokitIssueCommentsApi(octokit));
  const workspace = new CacheWorkspaceProvider(cloneUrl, workspaceDir);
  const runners = new DefaultRunnerRegistry();
  runners.register(new ClaudeCliRunner());
  runners.register(new CodexCliRunner());
  runners.register(new AnthropicApiRunner());

  const byId = new Map(repoConfigs.map((c) => [c.repo.id, c]));
  const pipelineDepsFor = (repoId: string): PipelineDeps => {
    const repoConfig = byId.get(repoId);
    if (!repoConfig) throw new ConfigError(`No enabled repo config for ${repoId}`);
    return {
      store,
      github,
      workspace,
      context,
      runners,
      publisher,
      repoConfig,
      logger,
      language: platform.defaultLanguage,
    };
  };

  return {
    platform,
    db,
    store,
    queue,
    github,
    context,
    runners,
    publisher,
    workspace,
    logger,
    repoConfigs,
    pipelineDepsFor,
  };
}

export interface OnboardingWiring {
  pipeline: OnboardingPipeline;
  platform: PlatformConfig;
  reposDir: string;
  workspacesDir: string;
}

/**
 * Build the onboarding pipeline (CLI `onboard`). The generator runs an agentic CLI in the
 * checkout — `claude -p` by default, or `codex exec` when `runner: "codex-cli"`.
 */
export function composeOnboarding(opts: { model?: string; runner?: string } = {}): OnboardingWiring {
  const platformPath = existsSync("./config/platform.yaml")
    ? "./config/platform.yaml"
    : "./config/platform.example.yaml";
  const platform = loadPlatformConfig(platformPath);
  mkdirSync(platform.reposDir, { recursive: true });
  mkdirSync(platform.workspacesDir, { recursive: true });

  const logger = createLogger("onboard", platform.logLevel);
  const generator: PackGenerator =
    opts.runner === "codex-cli"
      ? new CodexPackGenerator({ model: opts.model })
      : new ClaudeCliPackGenerator({ model: opts.model });
  const pipeline = new OnboardingPipeline({
    generator,
    reposDir: platform.reposDir,
    language: platform.defaultLanguage,
    logger,
  });
  return { pipeline, platform, reposDir: platform.reposDir, workspacesDir: platform.workspacesDir };
}

function loadRepoConfigFor(reposDir: string, repoId: string): RepoConfig {
  const dir = repoId.replace("/", "__");
  const p = join(reposDir, dir, "repo.yaml");
  if (!existsSync(p)) {
    throw new ConfigError(`No repo config at ${p}. Create config/repos/${dir}/repo.yaml (copy _example).`);
  }
  return loadRepoConfig(p);
}
