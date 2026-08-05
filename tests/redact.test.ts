import { describe, it, expect } from "vitest";
import { redactSecrets } from "../src/core";

describe("redactSecrets", () => {
  it("redacts the token in an authenticated git clone URL (the finding-1 leak shape)", () => {
    // A failed git clone/fetch surfaces the authenticated remote verbatim in message AND stack.
    const line = "fatal: unable to access 'https://x-access-token:ghs_AbC123secretDEF456@github.com/o/r.git/'";
    const out = redactSecrets(line);
    expect(out).not.toContain("ghs_AbC123secretDEF456");
    expect(out).toContain("x-access-token:***@github.com");
  });

  it("redacts any scheme's userinfo password (user:secret@host -> user:***@host)", () => {
    expect(redactSecrets("https://user:hunter2@example.com/x")).toBe("https://user:***@example.com/x");
    const out = redactSecrets("postgres://admin:p4ssw0rd@db:5432/app");
    expect(out).not.toContain("p4ssw0rd");
    expect(out).toContain(":***@");
  });

  it("redacts standalone GitHub tokens by documented prefix", () => {
    for (const prefix of ["ghp_", "gho_", "ghs_", "ghu_", "ghr_", "github_pat_"]) {
      const tok = `${prefix}0123456789abcdefABCDEF`;
      const out = redactSecrets(`x-access-token is ${tok} here`);
      expect(out).not.toContain(tok);
      expect(out).toContain(`${prefix}***`);
    }
  });

  it("redacts Authorization header/JSON credential values", () => {
    const header = redactSecrets("Authorization: Bearer abcDEF123.token_value");
    expect(header).not.toContain("abcDEF123.token_value");
    expect(header).toContain("***");

    const json = redactSecrets('"authorization":"token ghp_zzzzzzzzzzzzzzzz"');
    expect(json).not.toContain("ghp_zzzzzzzzzzzzzzzz");
    expect(json).toContain("***");
  });

  it("leaves credential-free text untouched and is safe on empty input", () => {
    const clean = "reviewing owner/repo#7@abcd1234 via codex [security-baseline] 3 files";
    expect(redactSecrets(clean)).toBe(clean);
    expect(redactSecrets("")).toBe("");
  });
});
