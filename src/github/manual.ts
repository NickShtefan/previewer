import type { GitHubClient, PrRef, PullRequestMeta, DiffResult } from "../core";

export interface ManualPr {
  prNumber: number;
  headSha: string;
  baseSha: string;
  title?: string;
  body?: string;
  author?: string;
  isDraft?: boolean;
}

/**
 * A GitHubClient that serves PR metadata from explicit CLI flags (`--head`/`--base`),
 * so a `--local --dry-run` review needs no GitHub API access at all.
 */
export class ManualPullSource implements GitHubClient {
  constructor(private readonly pr: ManualPr) {}

  async getPullRequest(_ref: PrRef): Promise<PullRequestMeta> {
    return {
      number: this.pr.prNumber,
      title: this.pr.title ?? `PR #${this.pr.prNumber}`,
      body: this.pr.body ?? "",
      baseSha: this.pr.baseSha,
      headSha: this.pr.headSha,
      author: this.pr.author ?? "local",
      isDraft: this.pr.isDraft ?? false,
      state: "open",
    };
  }
  async listOpenPullRequests(): Promise<PullRequestMeta[]> {
    return [];
  }
  async checkout(): Promise<{ dir: string }> {
    throw new Error("ManualPullSource has no checkout (use a WorkspaceProvider)");
  }
  async diff(): Promise<DiffResult> {
    throw new Error("ManualPullSource has no diff (use a WorkspaceProvider)");
  }
}
