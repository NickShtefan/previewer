import { describe, it, expect } from "vitest";
import { openDatabase, SqliteStore, SqliteQueue } from "../src/store";
import { handleWebhook, type IngressDeps, type WebhookRequest } from "../src/apps/ingress/server";
import { RepoConfig } from "../src/config";
import type { PullRequestMeta } from "../src/core";

const payload = (action: string, opts: { draft?: boolean; repo?: string; head?: string } = {}): string =>
  JSON.stringify({
    action,
    number: 7,
    repository: { full_name: opts.repo ?? "owner/repo" },
    pull_request: {
      number: 7,
      title: "t",
      body: "",
      draft: opts.draft ?? false,
      state: "open",
      head: { sha: opts.head ?? "head1234" },
      base: { sha: "base1234" },
      user: { login: "a" },
    },
  });

const prMeta = (over: Partial<PullRequestMeta> = {}): PullRequestMeta => ({
  number: 7,
  title: "t",
  body: "",
  baseSha: "base1234",
  headSha: "head1234",
  author: "a",
  isDraft: false,
  state: "open",
  ...over,
});

function setup(verify = true, pr: Partial<PullRequestMeta> = {}) {
  const db = openDatabase(":memory:");
  const store = new SqliteStore(db);
  const queue = new SqliteQueue(db);
  const cfg = RepoConfig.parse({ repo: { id: "owner/repo" } });
  const warnings: string[] = [];
  const deps: IngressDeps = {
    verifier: { verify: () => verify },
    store,
    queue,
    github: { getPullRequest: async () => prMeta(pr) },
    repoConfigs: [cfg],
    logger: { info() {}, warn: (m) => warnings.push(m) },
  };
  return { db, store, queue, deps, warnings };
}

const req = (over: Partial<WebhookRequest> = {}): WebhookRequest => ({
  event: "pull_request",
  deliveryId: "d1",
  signature: "sig",
  rawBody: payload("synchronize"),
  ...over,
});

// --- issue_comment builders --------------------------------------------------
const commentPayload = (
  o: { action?: string; body?: string; assoc?: string; isPr?: boolean; repo?: string; issue?: number } = {},
): string =>
  JSON.stringify({
    action: o.action ?? "created",
    issue: {
      number: o.issue ?? 7,
      ...(o.isPr === false ? {} : { pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/7" } }),
    },
    comment: {
      body: o.body ?? "/rereview",
      user: { login: "commenter" },
      author_association: o.assoc ?? "OWNER",
    },
    repository: { full_name: o.repo ?? "owner/repo" },
  });

const commentReq = (over: Partial<WebhookRequest> = {}): WebhookRequest => ({
  event: "issue_comment",
  deliveryId: "c1",
  signature: "sig",
  rawBody: commentPayload(),
  ...over,
});

describe("handleWebhook — pull_request", () => {
  it("rejects a bad signature", async () => {
    const { deps } = setup(false);
    const o = await handleWebhook(deps, req());
    expect(o.status).toBe(401);
    expect(o.kind).toBe("bad-signature");
  });

  it("acks a ping", async () => {
    const { deps } = setup();
    const o = await handleWebhook(deps, req({ event: "ping", rawBody: "{}" }));
    expect(o.kind).toBe("ping");
    expect(o.status).toBe(200);
  });

  it("enqueues a relevant PR event", async () => {
    const { deps, queue } = setup();
    const o = await handleWebhook(deps, req({ rawBody: payload("synchronize", { head: "abc123" }) }));
    expect(o.kind).toBe("enqueued");
    expect(queue.getByKey("owner/repo", 7, "abc123")).not.toBeNull();
  });

  it("ignores drafts", async () => {
    const { deps } = setup();
    const o = await handleWebhook(deps, req({ rawBody: payload("opened", { draft: true }) }));
    expect(o.kind).toBe("ignored");
  });

  it("ignores non-pull_request events and unconfigured repos", async () => {
    const { deps } = setup();
    expect((await handleWebhook(deps, req({ event: "push" }))).kind).toBe("ignored");
    expect((await handleWebhook(deps, req({ rawBody: payload("synchronize", { repo: "x/y" }) }))).kind).toBe("ignored");
  });

  it("dedups a repeated delivery id", async () => {
    const { deps } = setup();
    await handleWebhook(deps, req({ deliveryId: "dup" }));
    const o2 = await handleWebhook(deps, req({ deliveryId: "dup" }));
    expect(o2.kind).toBe("duplicate-delivery");
  });

  it("treats a re-delivered same SHA as already-queued (idempotent)", async () => {
    const { deps } = setup();
    await handleWebhook(deps, req({ deliveryId: "a", rawBody: payload("synchronize", { head: "z9" }) }));
    const o2 = await handleWebhook(deps, req({ deliveryId: "b", rawBody: payload("synchronize", { head: "z9" }) }));
    expect(o2.kind).toBe("queued-duplicate");
  });
});

describe("handleWebhook — issue_comment /rereview", () => {
  it("enqueues a forced full re-review of the current head from an OWNER", async () => {
    const { deps, queue } = setup(true, { headSha: "cur7777", baseSha: "base000" });
    const o = await handleWebhook(deps, commentReq());
    expect(o.kind).toBe("enqueued");
    expect(o.enqueued).toEqual({ repo: "owner/repo", prNumber: 7, headSha: "cur7777" });
    const job = queue.getByKey("owner/repo", 7, "cur7777");
    expect(job).not.toBeNull();
    expect(job!.full).toBe(true); // forces base..head in the pipeline
    expect(job!.source).toBe("manual");
  });

  it("honors @previewer rereview and is case-insensitive", async () => {
    const { deps, queue } = setup(true, { headSha: "cur7777" });
    const o = await handleWebhook(deps, commentReq({ rawBody: commentPayload({ body: "@previewer Rereview please" }) }));
    expect(o.kind).toBe("enqueued");
    expect(queue.getByKey("owner/repo", 7, "cur7777")).not.toBeNull();
  });

  it("ignores a command from a non-write author (author_association)", async () => {
    const { deps, queue, warnings } = setup(true, { headSha: "cur7777" });
    const o = await handleWebhook(deps, commentReq({ rawBody: commentPayload({ assoc: "CONTRIBUTOR" }) }));
    expect(o.kind).toBe("ignored");
    expect(queue.getByKey("owner/repo", 7, "cur7777")).toBeNull(); // nothing enqueued
    expect(warnings.some((w) => w.includes("commenter"))).toBe(true); // logged, not silent-to-ops
  });

  it("ignores a non-command comment", async () => {
    const { deps, queue } = setup(true, { headSha: "cur7777" });
    const o = await handleWebhook(deps, commentReq({ rawBody: commentPayload({ body: "nice work, LGTM" }) }));
    expect(o.kind).toBe("ignored");
    expect(queue.getByKey("owner/repo", 7, "cur7777")).toBeNull();
  });

  it("ignores edited and deleted comment actions", async () => {
    const { deps } = setup(true, { headSha: "cur7777" });
    expect(
      (await handleWebhook(deps, commentReq({ deliveryId: "e1", rawBody: commentPayload({ action: "edited" }) }))).kind,
    ).toBe("ignored");
    expect(
      (await handleWebhook(deps, commentReq({ deliveryId: "e2", rawBody: commentPayload({ action: "deleted" }) }))).kind,
    ).toBe("ignored");
  });

  it("ignores a command on a non-PR issue", async () => {
    const { deps } = setup(true);
    const o = await handleWebhook(deps, commentReq({ rawBody: commentPayload({ isPr: false }) }));
    expect(o.kind).toBe("ignored");
  });

  it("ignores a command for an unconfigured repo", async () => {
    const { deps } = setup(true);
    const o = await handleWebhook(deps, commentReq({ rawBody: commentPayload({ repo: "x/y" }) }));
    expect(o.kind).toBe("ignored");
  });

  it("dedups a redelivered comment webhook (no double enqueue)", async () => {
    const { deps, queue } = setup(true, { headSha: "cur7777" });
    const a = await handleWebhook(deps, commentReq({ deliveryId: "same" }));
    expect(a.kind).toBe("enqueued");
    const b = await handleWebhook(deps, commentReq({ deliveryId: "same" }));
    expect(b.kind).toBe("duplicate-delivery");
    expect(queue.getByKey("owner/repo", 7, "cur7777")).not.toBeNull();
  });

  it("re-queues an already-completed head so a later /rereview actually re-runs", async () => {
    const { deps, queue } = setup(true, { headSha: "cur7777" });
    await handleWebhook(deps, commentReq({ deliveryId: "r1" }));
    const leased = await queue.lease(1000);
    await queue.ack(leased!.leaseId);
    expect(queue.getByKey("owner/repo", 7, "cur7777")!.status).toBe("done");

    const o = await handleWebhook(deps, commentReq({ deliveryId: "r2" }));
    expect(o.kind).toBe("enqueued");
    expect(queue.getByKey("owner/repo", 7, "cur7777")!.status).toBe("queued");
    expect(await queue.lease(1000)).not.toBeNull();
  });
});
