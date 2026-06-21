import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import type { PullsApi, IssueCommentsApi, PullSummary } from "./ports";

export interface GithubAppConfig {
  appId: string | number;
  privateKey: string;
  installationId: string | number;
}

/** Octokit authenticated as a GitHub App installation (short-lived token). */
export function createInstallationOctokit(cfg: GithubAppConfig): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: cfg.appId,
      privateKey: cfg.privateKey,
      installationId: cfg.installationId,
    },
  });
}

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  return { owner: owner ?? "", repo: name ?? "" };
}

// Minimal response shapes we read — keeps us decoupled from Octokit's exact types.
interface PrData {
  number: number;
  title: string;
  body: string | null;
  head: { sha: string };
  base: { sha: string };
  user: { login: string } | null;
  draft?: boolean;
  state: string;
}
interface CommentData {
  id: number;
  body?: string | null;
}

function toSummary(d: PrData): PullSummary {
  return {
    number: d.number,
    title: d.title ?? "",
    body: d.body ?? "",
    head: { sha: d.head.sha },
    base: { sha: d.base.sha },
    user: { login: d.user?.login ?? "" },
    draft: Boolean(d.draft),
    state: d.state === "closed" ? "closed" : "open",
  };
}

export function octokitPullsApi(octokit: Octokit): PullsApi {
  return {
    async get(repo, prNumber) {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber });
      return toSummary(data as unknown as PrData);
    },
    async listOpen(repo) {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await octokit.pulls.list({ owner, repo: name, state: "open", per_page: 100 });
      return (data as unknown as PrData[]).map(toSummary);
    },
  };
}

export function octokitIssueCommentsApi(octokit: Octokit): IssueCommentsApi {
  return {
    async list(repo, issueNumber) {
      const { owner, repo: name } = splitRepo(repo);
      // First 100 comments is enough to find our marker in practice; paginate later if needed.
      const { data } = await octokit.issues.listComments({
        owner,
        repo: name,
        issue_number: issueNumber,
        per_page: 100,
      });
      return (data as unknown as CommentData[]).map((c) => ({ id: c.id, body: c.body ?? "" }));
    },
    async create(repo, issueNumber, body) {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await octokit.issues.createComment({
        owner,
        repo: name,
        issue_number: issueNumber,
        body,
      });
      return { id: data.id };
    },
    async update(repo, commentId, body) {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await octokit.issues.updateComment({
        owner,
        repo: name,
        comment_id: commentId,
        body,
      });
      return { id: data.id };
    },
  };
}
