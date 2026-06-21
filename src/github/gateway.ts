import type { GitHubClient, PrRef, PullRequestMeta, DiffResult } from "../core";
import type { PullsApi, PullSummary } from "./ports";
import { gitDiff, ensureCheckout, ensureSha } from "./git";

export interface GithubGatewayOptions {
  pulls: PullsApi;
  /** Authenticated clone URL for a repo, e.g. https://x-access-token:TOKEN@github.com/owner/name.git */
  cloneUrl: (repo: string) => string;
  /** Local cache dir for a repo's checkout. */
  workspaceDir: (repo: string) => string;
}

function toMeta(pr: PullSummary): PullRequestMeta {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    author: pr.user.login,
    isDraft: pr.draft,
    state: pr.state,
  };
}

/** GitHub App-backed read access + local checkout/diff. */
export class GithubGateway implements GitHubClient {
  constructor(private readonly opts: GithubGatewayOptions) {}

  async getPullRequest(ref: PrRef): Promise<PullRequestMeta> {
    return toMeta(await this.opts.pulls.get(ref.repo, ref.prNumber));
  }

  async listOpenPullRequests(repo: string): Promise<PullRequestMeta[]> {
    return (await this.opts.pulls.listOpen(repo)).map(toMeta);
  }

  async checkout(repo: string, sha: string): Promise<{ dir: string }> {
    return ensureCheckout({ url: this.opts.cloneUrl(repo), dir: this.opts.workspaceDir(repo), sha });
  }

  async diff(
    repo: string,
    fromSha: string,
    toSha: string,
    mode: "incremental" | "full",
  ): Promise<DiffResult> {
    const dir = this.opts.workspaceDir(repo);
    if (mode === "incremental") await ensureSha(dir, fromSha);
    const { patch, changedFiles } = await gitDiff(dir, fromSha, toSha);
    return { mode, fromSha, toSha, patch, changedFiles };
  }
}
