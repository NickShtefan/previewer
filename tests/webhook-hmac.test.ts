import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { GithubWebhookVerifier, extractPullRequestEvent, isRelevant } from "../src/github";

const SECRET = "s3cr3t-webhook-key";
const sign = (body: string) =>
  "sha256=" + createHmac("sha256", SECRET).update(body, "utf8").digest("hex");

describe("GithubWebhookVerifier (HMAC-SHA256)", () => {
  const v = new GithubWebhookVerifier(SECRET);

  it("accepts a valid signature", () => {
    const body = JSON.stringify({ hello: "world", n: 1 });
    expect(v.verify(body, sign(body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(v.verify(body + " ", sign(body))).toBe(false);
  });

  it("rejects a wrong, short, or empty signature", () => {
    expect(v.verify("body", "sha256=deadbeef")).toBe(false);
    expect(v.verify("body", "")).toBe(false);
    expect(v.verify("body", "not-even-prefixed")).toBe(false);
  });
});

describe("extractPullRequestEvent + isRelevant", () => {
  const payload = {
    action: "synchronize",
    number: 7,
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: 7,
      title: "Add feature",
      body: "desc",
      draft: false,
      state: "open",
      head: { sha: "head1234" },
      base: { sha: "base1234" },
      user: { login: "alice" },
    },
  };

  it("normalizes the fields we care about", () => {
    const ev = extractPullRequestEvent(payload)!;
    expect(ev.repo).toBe("owner/repo");
    expect(ev.prNumber).toBe(7);
    expect(ev.headSha).toBe("head1234");
    expect(ev.baseSha).toBe("base1234");
    expect(ev.author).toBe("alice");
    expect(isRelevant(ev)).toBe(true);
  });

  it("filters drafts and irrelevant actions", () => {
    const base = extractPullRequestEvent(payload)!;
    expect(isRelevant({ ...base, isDraft: true })).toBe(false);
    expect(isRelevant({ ...base, action: "labeled" })).toBe(false);
    expect(isRelevant({ ...base, action: "ready_for_review" })).toBe(true);
  });

  it("returns null for non-pull_request payloads", () => {
    expect(extractPullRequestEvent({ foo: 1 })).toBeNull();
    expect(extractPullRequestEvent(null)).toBeNull();
  });
});
