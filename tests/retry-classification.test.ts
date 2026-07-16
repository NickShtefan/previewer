import { describe, it, expect } from "vitest";
import { classifyFailure } from "../src/core";

/** Build an Octokit-style RequestError (has a numeric `status`). */
const httpError = (status: number, message = `HTTP ${status}`): Error => {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
};

/** Build a Node/undici socket error (has a string `code`). */
const netError = (code: string): Error => {
  const e = new Error(`request to github.com failed, reason: ${code}`) as Error & { code: string };
  e.code = code;
  return e;
};

describe("classifyFailure — transient (retry through an outage)", () => {
  it("classifies GitHub 5xx as transient", () => {
    for (const s of [500, 502, 503, 504, 599]) {
      expect(classifyFailure(httpError(s))).toBe("transient");
    }
  });

  it("classifies 429 (rate limited) as transient", () => {
    expect(classifyFailure(httpError(429, "Too Many Requests"))).toBe("transient");
  });

  it("classifies a 403 secondary rate limit as transient (a 4xx that clears)", () => {
    expect(classifyFailure(httpError(403, "You have exceeded a secondary rate limit"))).toBe("transient");
  });

  it("classifies an HTML-where-JSON error page (JSON.parse blow-up) as transient", () => {
    // The exact shape thrown when GitHub returns a 503 HTML page and the client does JSON.parse.
    expect(classifyFailure(new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`))).toBe(
      "transient",
    );
    expect(classifyFailure(new Error("invalid character '<' looking for beginning of value"))).toBe("transient");
    expect(classifyFailure(new Error("GitHub is having a problem — Unicorn!"))).toBe("transient");
  });

  it("classifies network errors (ECONNRESET/ETIMEDOUT/ENOTFOUND/EAI_AGAIN/ECONNREFUSED) as transient", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]) {
      expect(classifyFailure(netError(code))).toBe("transient");
    }
  });

  it("classifies request timeouts / aborts as transient", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(classifyFailure(abort)).toBe("transient");
    expect(classifyFailure(new Error("request timed out after 30000ms"))).toBe("transient");
  });

  it("classifies usage/rate limit and overload text as transient", () => {
    expect(classifyFailure("usage limit reached; try again at 5pm")).toBe("transient");
    expect(classifyFailure("Overloaded")).toBe("transient");
    expect(classifyFailure("503 Service Unavailable")).toBe("transient");
  });
});

describe("classifyFailure — permanent (fail fast)", () => {
  it("classifies 4xx (other than 429) as permanent", () => {
    for (const s of [400, 404, 422]) {
      expect(classifyFailure(httpError(s, "Validation Failed"))).toBe("permanent");
    }
  });

  it("classifies auth failures as permanent", () => {
    expect(classifyFailure(httpError(401, "Bad credentials"))).toBe("permanent");
    expect(classifyFailure(new Error("Resource not accessible by integration"))).toBe("permanent");
  });

  it("classifies a programming error (TypeError) as permanent", () => {
    expect(classifyFailure(new TypeError("Cannot read properties of undefined (reading 'sha')"))).toBe("permanent");
  });

  it("defaults an unknown error to permanent", () => {
    expect(classifyFailure(new Error("something weird happened"))).toBe("permanent");
    expect(classifyFailure(undefined)).toBe("permanent");
  });
});
