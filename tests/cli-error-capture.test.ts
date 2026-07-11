import { describe, it, expect } from "vitest";
import { describeCliFailure, CLI_ERROR_DETAIL_MAX } from "../src/runners";

/* describeCliFailure is the load-bearing fix: a failed CLI run's real error must survive
   both traps that `(stderr || stdout).slice(0, 500)` fell into - a benign stderr banner
   masking a stdout error, and a head-slice dropping the trailing error of a long stream. */

describe("describeCliFailure", () => {
  it("captures the real stdout error when stderr holds only the stdin banner", () => {
    const res = { stdout: "boom: real error here", stderr: "Reading prompt from stdin...\n" };
    const { summary, detail } = describeCliFailure(res);
    expect(summary).toBe("boom: real error here");
    expect(detail).toContain("real error here");
    expect(detail).not.toContain("Reading prompt from stdin");
  });

  it("preserves the TAIL of a long stderr where the real error lives", () => {
    const filler = Array.from({ length: 500 }, (_, i) => `FILLER_${i}`).join("\n");
    const stderr = `${filler}\nFATAL: rate limit exceeded (429)`;
    const { summary, detail } = describeCliFailure({ stdout: "", stderr });
    expect(summary).toBe("FATAL: rate limit exceeded (429)");
    expect(detail).toContain("FATAL: rate limit exceeded (429)");
    expect(detail).not.toContain("FILLER_0"); // head dropped
    expect(detail.length).toBeLessThanOrEqual(CLI_ERROR_DETAIL_MAX + 200);
  });

  it("returns 'no output' when both streams are empty", () => {
    const { summary, detail } = describeCliFailure({ stdout: "", stderr: "" });
    expect(summary).toBe("no output");
    expect(detail).toBe("no output");
  });

  it("returns 'no output' when the only content is noise", () => {
    const { summary, detail } = describeCliFailure({ stdout: "", stderr: "Reading prompt from stdin...\n" });
    expect(summary).toBe("no output");
    expect(detail).toBe("no output");
  });

  it("labels both streams when each carries meaningful lines", () => {
    const res = { stdout: "partial output\nmore stdout", stderr: "Reading prompt from stdin...\nreal stderr error" };
    const { summary, detail } = describeCliFailure(res);
    expect(summary).toBe("real stderr error"); // last meaningful line overall
    expect(detail).toContain("stdout:");
    expect(detail).toContain("stderr:");
    expect(detail).toContain("real stderr error");
    expect(detail).not.toContain("Reading prompt from stdin");
  });

  it("returns a single clean line without labels when there is only one meaningful line", () => {
    const { detail } = describeCliFailure({ stdout: "only one line", stderr: "" });
    expect(detail).toBe("only one line");
  });
});
