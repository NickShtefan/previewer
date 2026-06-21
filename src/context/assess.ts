import { existsSync } from "node:fs";
import { join } from "node:path";
import { ContextAssessment, type ArtifactDecision } from "../config";
import type { DiscoveredDoc } from "../core";
import { readMaybe } from "./fs-scan";
import type { Discovery } from "./discover";

/** Pack artifacts that, when generated/augmented, require the model (agentic runner). */
export const MODEL_ARTIFACTS = new Set(["repoGuide", "subsystems", "routing", "profiles", "invariants"]);

/** All artifacts the onboarding rubric reasons about (securityBaseline + commentTemplate have platform defaults). */
export const ARTIFACTS = [
  "repoGuide",
  "subsystems",
  "routing",
  "profiles",
  "invariants",
  "securityBaseline",
  "commentTemplate",
] as const;
export type ArtifactName = (typeof ARTIFACTS)[number];

export interface ArtifactPlan {
  artifact: ArtifactName;
  decision: ArtifactDecision; // ingest | augment | generate
  /** Single source (markdown/yaml) backing an ingest, or the seed for augment. */
  source?: DiscoveredDoc;
  /** Multiple sources (subsystems from nested AGENTS.md; invariants from docs + AGENTS). */
  sources?: DiscoveredDoc[];
  assessment?: ContextAssessment;
}

export interface AssessmentResult {
  plans: ArtifactPlan[];
  overall?: ContextAssessment;
}

const SECURITY_RE = /(security|privacy|auth|secret|leak|vuln|inject|xss|csrf|sanitiz|exfiltrat|sensitive|token|session)/i;
const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+/g;
const BACKTICK_RE = /`([^`]+)`/g;

/** Path-like references in a doc (for the freshness check). */
function referencedPaths(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(PATH_RE)) out.add(m[0]);
  for (const m of content.matchAll(BACKTICK_RE)) {
    const inner = m[1];
    if (inner && /^[\w.-]+(\/[\w.-]+)+$/.test(inner)) out.add(inner);
  }
  return [...out].slice(0, 40);
}

/** Score one discovered doc against the rubric (coverage/specificity/freshness/security/machineUsability). */
export function scoreDoc(repoDir: string, doc: DiscoveredDoc, opts: { ourSchema?: boolean } = {}): ContextAssessment {
  const content = readMaybe(repoDir, doc.path) ?? doc.excerpt;
  const len = content.length;

  const coverage = Math.min(1, len / 1200);

  const refs = (content.match(PATH_RE)?.length ?? 0) + (content.match(BACKTICK_RE)?.length ?? 0);
  const specificity = Math.min(1, refs / 8);

  const paths = referencedPaths(content);
  let freshness = 0.6; // neutral when a doc references no concrete paths
  if (paths.length) {
    const alive = paths.filter((p) => existsSync(join(repoDir, p))).length;
    freshness = alive / paths.length;
  }

  const security = SECURITY_RE.test(content) ? 1 : 0.3;

  let machineUsability = 0.3;
  if (opts.ourSchema) machineUsability = 1;
  else if (/^\s*#{1,3}\s/m.test(content) || /^\s*[\w-]+:\s/m.test(content)) machineUsability = 0.6;

  return ContextAssessment.parse({ coverage, specificity, freshness, security, machineUsability });
}

/** Quality dims average (drives the ingest/augment/generate gate). */
export function overallScore(a: ContextAssessment): number {
  return (a.coverage + a.specificity + a.freshness + a.machineUsability) / 4;
}

function decide(score: number, threshold: number): ArtifactDecision {
  if (score >= threshold) return "ingest";
  if (score >= 0.4) return "augment";
  return "generate";
}

/** Does this plan need the agentic model to produce it? */
export function planNeedsModel(p: ArtifactPlan): boolean {
  return (p.decision === "generate" || p.decision === "augment") && MODEL_ARTIFACTS.has(p.artifact);
}

/**
 * Per-artifact use-existing-vs-generate rubric (ARCHITECTURE §8). Markdown artifacts
 * (repoGuide, subsystems, commentTemplate) ingest verbatim when they score well; the
 * structured artifacts (routing/profiles/invariants) ingest only from an existing
 * normalized pack file, otherwise they are generated/augmented from the discovered docs.
 */
export function assessArtifacts(repoDir: string, d: Discovery, threshold: number): AssessmentResult {
  const plans: ArtifactPlan[] = [];
  const score = (doc: DiscoveredDoc, ourSchema = false): ContextAssessment => scoreDoc(repoDir, doc, { ourSchema });

  // repoGuide — root AGENTS.md / CLAUDE.md / README (markdown, verbatim-ingestible).
  const guideSrc = d.rootAgents ?? d.claudeMd ?? d.readme;
  if (guideSrc) {
    const a = score(guideSrc);
    plans.push({ artifact: "repoGuide", decision: decide(overallScore(a), threshold), source: guideSrc, assessment: a });
  } else {
    plans.push({ artifact: "repoGuide", decision: "generate" });
  }

  // subsystems — normalized pack files first, else nested AGENTS.md (authored guides → ingest).
  if (d.ourSchema.subsystems.length) {
    plans.push({
      artifact: "subsystems",
      decision: "ingest",
      sources: d.ourSchema.subsystems,
      assessment: score(d.ourSchema.subsystems[0]!, true),
    });
  } else if (d.nestedAgents.length) {
    plans.push({
      artifact: "subsystems",
      decision: "ingest",
      sources: d.nestedAgents,
      assessment: score(d.nestedAgents[0]!),
    });
  } else {
    plans.push({ artifact: "subsystems", decision: "generate" });
  }

  // routing — only an existing normalized routing.yaml ingests; a kourion-style file is augmented.
  if (d.ourSchema.routing) {
    plans.push({ artifact: "routing", decision: "ingest", source: d.ourSchema.routing, assessment: score(d.ourSchema.routing, true) });
  } else if (d.reviewerRouting) {
    plans.push({ artifact: "routing", decision: "augment", source: d.reviewerRouting, assessment: score(d.reviewerRouting) });
  } else {
    plans.push({ artifact: "routing", decision: "generate" });
  }

  // profiles — same shape as routing.
  if (d.ourSchema.profiles) {
    plans.push({ artifact: "profiles", decision: "ingest", source: d.ourSchema.profiles, assessment: score(d.ourSchema.profiles, true) });
  } else if (d.reviewerProfiles.length) {
    plans.push({ artifact: "profiles", decision: "augment", sources: d.reviewerProfiles, assessment: score(d.reviewerProfiles[0]!) });
  } else {
    plans.push({ artifact: "profiles", decision: "generate" });
  }

  // invariants — never ingest from prose (must be structured + human-confirmed); only a pack file ingests.
  if (d.ourSchema.invariants) {
    plans.push({ artifact: "invariants", decision: "ingest", source: d.ourSchema.invariants, assessment: score(d.ourSchema.invariants, true) });
  } else {
    const sources = [...d.invariantDocs];
    if (d.rootAgents) sources.push(d.rootAgents);
    plans.push({ artifact: "invariants", decision: "generate", sources: sources.length ? sources : undefined });
  }

  // securityBaseline — pack file ingests; otherwise platform defaults (+ repo extras), produced without the model.
  if (d.ourSchema.securityBaseline) {
    plans.push({ artifact: "securityBaseline", decision: "ingest", source: d.ourSchema.securityBaseline, assessment: score(d.ourSchema.securityBaseline, true) });
  } else {
    plans.push({ artifact: "securityBaseline", decision: "generate", source: d.securityDoc });
  }

  // commentTemplate — discovered template ingests verbatim; otherwise platform default.
  if (d.commentTemplate) {
    plans.push({ artifact: "commentTemplate", decision: "ingest", source: d.commentTemplate, assessment: score(d.commentTemplate) });
  } else {
    plans.push({ artifact: "commentTemplate", decision: "generate" });
  }

  const scored = plans.map((p) => p.assessment).filter((a): a is ContextAssessment => Boolean(a));
  const overall = scored.length
    ? ContextAssessment.parse({
        coverage: avg(scored.map((a) => a.coverage)),
        specificity: avg(scored.map((a) => a.specificity)),
        freshness: avg(scored.map((a) => a.freshness)),
        security: avg(scored.map((a) => a.security)),
        machineUsability: avg(scored.map((a) => a.machineUsability)),
      })
    : undefined;

  return { plans, overall };
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
