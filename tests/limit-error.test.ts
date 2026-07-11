import { describe, it, expect } from "vitest";
import { isLimitError } from "../src/core";

describe("isLimitError", () => {
  it("matches usage/rate-limit phrasings (case-insensitive)", () => {
    for (const m of [
      "usage limit reached",
      "You have hit the RATE LIMIT",
      "429 Too Many Requests",
      "Too Many Requests",
      "insufficient_quota: you exceeded your quota",
      "Please try again at 3:00 PM",
    ]) {
      expect(isLimitError(m)).toBe(true);
    }
  });

  it("does not match ordinary errors or nullish input", () => {
    for (const m of [
      "TypeError: cannot read property of undefined",
      "connection reset by peer",
      "gate: no reviewable files",
      "",
    ]) {
      expect(isLimitError(m)).toBe(false);
    }
    expect(isLimitError(null)).toBe(false);
    expect(isLimitError(undefined)).toBe(false);
  });
});
