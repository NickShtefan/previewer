import { z } from "zod";
import { Severity, Routing, Profiles, Invariant, SecurityBaseline, SubsystemGuide, RiskMap } from "../../config";
import type { ReviewInput, ReviewResult } from "../../config";
import type { GeneratedArtifacts } from "../../core";

/** Normalized view of a `claude -p --output-format json` envelope. */
export interface Envelope {
  isError: boolean;
  subtype: string;
  resultText: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  durationMs: number;
  numTurns: number;
}

export function parseEnvelope(stdout: string): Envelope {
  let obj: Record<string, any>;
  try {
    obj = JSON.parse(stdout);
  } catch {
    throw new Error("claude -p did not return a valid JSON envelope");
  }
  const usage = (obj.usage ?? {}) as Record<string, any>;
  return {
    isError: Boolean(obj.is_error),
    subtype: String(obj.subtype ?? ""),
    resultText: String(obj.result ?? ""),
    model: String(obj.model ?? "claude"),
    tokensIn: Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0),
    tokensOut: Number(usage.output_tokens ?? 0),
    usd: Number(obj.total_cost_usd ?? 0),
    durationMs: Number(obj.duration_ms ?? 0),
    numTurns: Number(obj.num_turns ?? 0),
  };
}

/** Normalized final text + usage extracted from a `codex exec --json` JSONL event stream. */
export interface CodexResult {
  resultText: string;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Parse `codex exec --json` output: a JSONL event stream. The agent's final answer is the
 * last `item.completed` of item-type `agent_message`; token usage is on `turn.completed`.
 * Throws if no agent message was produced (e.g. the run errored mid-turn).
 */
export function parseCodexEvents(stdout: string): CodexResult {
  let resultText = "";
  let tokensIn = 0;
  let tokensOut = 0;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: Record<string, any>;
    try {
      o = JSON.parse(t);
    } catch {
      continue; // non-JSON noise (shouldn't happen with --json, but be tolerant)
    }
    if (o.type === "item.completed" && o.item?.type === "agent_message" && typeof o.item.text === "string") {
      resultText = o.item.text; // last agent_message wins
    } else if (o.type === "turn.completed" && o.usage) {
      const u = o.usage as Record<string, any>;
      tokensIn = Number(u.input_tokens ?? 0) + Number(u.cached_input_tokens ?? 0);
      tokensOut = Number(u.output_tokens ?? 0) + Number(u.reasoning_output_tokens ?? 0);
    }
  }
  if (!resultText) throw new Error("codex exec produced no agent_message");
  return { resultText, tokensIn, tokensOut };
}

/** Max chars kept from a failed CLI run's combined output. We keep the TAIL, not the head:
    the real error lands at the end of the stream, while the head is usually startup banners
    (a prompt echo, a version line). A head-slice would keep only that noise. */
export const CLI_ERROR_DETAIL_MAX = 1500;

/** Progress/startup lines a CLI prints that are never the actual failure reason. Codex writes
    "Reading prompt from stdin..." to stderr before it has even begun work, so a bare
    `stderr || stdout` fallback surfaces only this banner and drops the real error on stdout. */
const CLI_NOISE_LINE_RE = /^reading prompt from stdin/i;

/** A failed CLI run boiled down to a one-line headline plus a fuller, tail-preserved detail. */
export interface CliFailureDetail {
  /** The last meaningful (non-empty, non-noise) line across both streams. Empty streams -> "no output". */
  summary: string;
  /** Headline plus the labelled, noise-stripped, tail-truncated body (<= CLI_ERROR_DETAIL_MAX). */
  detail: string;
}

function cleanCliLines(stream: string): string[] {
  return stream
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "" && !CLI_NOISE_LINE_RE.test(line.trim()));
}

function tailChars(text: string, max: number): string {
  return text.length <= max ? text : "..." + text.slice(text.length - max);
}

/**
 * Turn a failed CLI run's raw streams into a useful error detail.
 *
 * Two traps this avoids that a bare `(stderr || stdout).slice(0, N)` falls into:
 *   1. Codex writes a benign "Reading prompt from stdin..." banner to STDERR while the real
 *      error may be on STDOUT, so `stderr || stdout` returns only the banner.
 *   2. The real error is at the END of a long stream, so a head-slice keeps only the noise.
 *
 * So we merge BOTH streams (labelled, noise stripped), keep the TAIL, and lead with a one-line
 * headline so even a truncated view still shows the real reason.
 */
export function describeCliFailure(res: { stdout: string; stderr: string }): CliFailureDetail {
  const outLines = cleanCliLines(res.stdout);
  const errLines = cleanCliLines(res.stderr);
  const allLines = [...outLines, ...errLines];

  if (allLines.length === 0) return { summary: "no output", detail: "no output" };

  const summary = allLines[allLines.length - 1]!;
  if (allLines.length === 1) return { summary, detail: summary };

  const sections: string[] = [];
  if (outLines.length) sections.push(`stdout:\n${outLines.join("\n")}`);
  if (errLines.length) sections.push(`stderr:\n${errLines.join("\n")}`);
  const body = tailChars(sections.join("\n\n"), CLI_ERROR_DETAIL_MAX);
  return { summary, detail: `${summary}\n\n${body}` };
}

/** Tolerant JSON extraction: bare, ```json-fenced, or wrapped in prose. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(t.slice(first, last + 1));
    } catch {
      /* fall through */
    }
  }
  throw new Error("no parseable JSON object found in model output");
}

const LooseFinding = z.object({
  title: z.string(),
  severity: Severity.default("info"),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  category: z.string().default("correctness"),
  detail: z.string().default(""),
});

export const ModelOutput = z.object({
  status: z.enum(["ok", "skipped"]).default("ok"),
  comment: z.string(),
  findings: z.array(LooseFinding).default([]),
  residualRisk: z.string().default(""),
});

/** The strict JSON object an onboarding generation run must emit (all fields optional — only targets). */
export const OnboardingArtifacts = z.object({
  repoGuide: z.string().optional(),
  subsystems: z.array(SubsystemGuide).optional(),
  routing: Routing.optional(),
  profiles: Profiles.optional(),
  invariants: z.array(Invariant).optional(),
  securityBaseline: SecurityBaseline.optional(),
  commentTemplate: z.string().optional(),
  riskMap: RiskMap.optional(),
});

/** Parse a model's final JSON into pack artifacts (tolerant extraction + zod validation). */
export function parseOnboardingArtifacts(text: string): GeneratedArtifacts {
  return OnboardingArtifacts.parse(extractJson(text));
}

function severitySummary(findings: Array<{ severity: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}

export function errorResult(
  input: ReviewInput,
  runnerId: string,
  model: string,
  message: string,
  retriable = true,
): ReviewResult {
  return {
    status: "error",
    reviewedHeadSha: input.pr.headSha,
    findings: [],
    meta: {
      runnerId,
      model,
      profile: input.context.activeProfiles.join(","),
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      durationMs: 0,
    },
    error: { kind: "runner", message, retriable },
  };
}

/** Map an envelope into a ReviewResult, parsing the model's final JSON object. */
export function buildReviewResult(input: ReviewInput, runnerId: string, env: Envelope): ReviewResult {
  const meta = {
    runnerId,
    model: env.model,
    profile: input.context.activeProfiles.join(","),
    tokensIn: env.tokensIn,
    tokensOut: env.tokensOut,
    usd: env.usd,
    durationMs: env.durationMs,
  };

  let parsed: z.infer<typeof ModelOutput>;
  try {
    parsed = ModelOutput.parse(extractJson(env.resultText));
  } catch (e) {
    return {
      status: "error",
      reviewedHeadSha: input.pr.headSha,
      findings: [],
      meta,
      error: { kind: "parse", message: (e as Error).message, retriable: true },
    };
  }

  return {
    status: parsed.status,
    reviewedHeadSha: input.pr.headSha,
    comment: { bodyMarkdown: parsed.comment, severitySummary: severitySummary(parsed.findings) },
    findings: parsed.findings,
    meta,
  };
}
