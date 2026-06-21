import { z } from "zod";
import { Severity } from "../../config";
import type { ReviewInput, ReviewResult } from "../../config";

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
