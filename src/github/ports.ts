/**
 * Thin ports the gateway/publisher depend on, so the idempotency/diff logic is
 * testable with fakes and the real Octokit adapter (app.ts) stays at the edge.
 */

export interface PullSummary {
  number: number;
  title: string;
  body: string;
  head: { sha: string };
  base: { sha: string };
  user: { login: string };
  draft: boolean;
  state: "open" | "closed";
}

export interface PullsApi {
  get(repo: string, prNumber: number): Promise<PullSummary>;
  listOpen(repo: string): Promise<PullSummary[]>;
}

export interface IssueCommentsApi {
  list(repo: string, issueNumber: number): Promise<Array<{ id: number; body: string }>>;
  create(repo: string, issueNumber: number, body: string): Promise<{ id: number }>;
  update(repo: string, commentId: number, body: string): Promise<{ id: number }>;
}
