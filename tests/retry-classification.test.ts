import { describe, it, expect } from "vitest";
import { classifyFailure, describeFailure } from "../src/core";

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

/** Build a git child-process failure (execFile shape: exit 128 numeric code, transport text in stderr). */
const gitError = (stderr: string, message = "Command failed: git fetch --depth=1 origin"): Error => {
  const e = new Error(message) as Error & { code: number; stderr: string };
  e.code = 128; // git's exit code — NOT a network string code, so classification must come from the text
  e.stderr = stderr;
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

describe("classifyFailure — git transport (clone/fetch during an outage)", () => {
  it("classifies git transport failures (text in stderr, exit 128) as transient", () => {
    // The exact shapes that stranded jobs when git checkout failed during the GitHub outage.
    const stderrs = [
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      "ssh: Temporary failure in name resolution",
      "fatal: The remote end hung up unexpectedly",
      "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503",
      "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429",
      "fatal: could not fetch 725daf62b from promisor remote",
      "fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443: Connection timed out",
      "error: RPC failed; curl 92 HTTP/2 stream 5 was reset",
      "fatal: early EOF",
      "fatal: unable to access '...': gnutls_handshake() failed",
    ];
    for (const s of stderrs) {
      expect(classifyFailure(gitError(s))).toBe("transient");
    }
  });

  it("classifies a git transport failure whose text is only in the message (no stderr) as transient", () => {
    expect(
      classifyFailure(
        new Error("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"),
      ),
    ).toBe("transient");
  });

  it("does NOT force-classify an unrelated git failure (e.g. bad revision) as transient", () => {
    // No transport phrase and no HTTP/network signal -> falls through to unknown (journaled, bounded retry).
    expect(classifyFailure(gitError("fatal: bad revision 'deadbeef'"))).toBe("unknown");
  });

  it("does NOT treat a permanent git access failure (403/404) as transient (no infinite retry)", () => {
    // "unable to access" fronts both transient and permanent causes; only the specific cause matches.
    // A 403/404 has neither a transport phrase nor a retriable HTTP status -> unknown (bounded), not transient.
    expect(
      classifyFailure(gitError("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403")),
    ).toBe("unknown");
    expect(
      classifyFailure(gitError("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 404")),
    ).toBe("unknown");
  });

  it("classifies an SSH permission-denied auth failure as PERMANENT, not transient", () => {
    // "could not read from remote repository" is the suffix of BOTH a transient blip and a permanent
    // auth failure; a real auth failure carries "Permission denied (publickey)" -> permanent (AUTH_RE).
    expect(
      classifyFailure(gitError("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.")),
    ).toBe("permanent");
  });

  it("treats the ambiguous 'could not read from remote repository' alone as unknown (bounded), not transient", () => {
    // No transport signal and no auth signal -> unknown: bounded retry + journaled, never infinite-transient.
    expect(classifyFailure(gitError("fatal: Could not read from remote repository."))).toBe("unknown");
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
});

describe("classifyFailure — unknown (unrecognised fall-through)", () => {
  it("classifies a programming error (TypeError) as unknown (so it is journaled, not silently permanent)", () => {
    expect(classifyFailure(new TypeError("Cannot read properties of undefined (reading 'sha')"))).toBe("unknown");
  });

  it("classifies an unrecognised error (incl. an unhandled 3xx status) as unknown", () => {
    expect(classifyFailure(new Error("something weird happened"))).toBe("unknown");
    expect(classifyFailure(httpError(301, "Moved Permanently"))).toBe("unknown"); // neither transient nor 4xx/auth
    expect(classifyFailure(undefined)).toBe("unknown");
  });
});

describe("describeFailure — diagnostic extraction", () => {
  it("captures message, status, code, name, and stack for journaling", () => {
    const e = new Error("boom") as Error & { status: number; code: string };
    e.status = 500;
    e.code = "ECONNRESET";
    const d = describeFailure(e);
    expect(d.message).toBe("boom");
    expect(d.status).toBe(500);
    expect(d.code).toBe("ECONNRESET");
    expect(d.name).toBe("Error");
    expect(d.stack).toContain("boom");
  });

  it("captures stderr (git shells out; the transport error text lands there, not in message)", () => {
    const e = new Error("Command failed: git fetch") as Error & { stderr: string };
    e.stderr = "fatal: Could not resolve host: github.com";
    const d = describeFailure(e);
    expect(d.stderr).toBe("fatal: Could not resolve host: github.com");
  });
});
