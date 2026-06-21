import { describe, it, expect } from "vitest";
import { openDatabase, SqliteStore, SqliteQueue } from "../src/store";
import { handleWebhook, type IngressDeps, type WebhookRequest } from "../src/apps/ingress/server";
import { RepoConfig } from "../src/config";

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

function setup(verify = true) {
  const db = openDatabase(":memory:");
  const store = new SqliteStore(db);
  const queue = new SqliteQueue(db);
  const cfg = RepoConfig.parse({ repo: { id: "owner/repo" } });
  const deps: IngressDeps = {
    verifier: { verify: () => verify },
    store,
    queue,
    repoConfigs: [cfg],
    logger: { info() {}, warn() {} },
  };
  return { db, store, queue, deps };
}

const req = (over: Partial<WebhookRequest> = {}): WebhookRequest => ({
  event: "pull_request",
  deliveryId: "d1",
  signature: "sig",
  rawBody: payload("synchronize"),
  ...over,
});

describe("handleWebhook", () => {
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
