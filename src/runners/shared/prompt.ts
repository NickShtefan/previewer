import type { ReviewInput } from "../../config";
import { commentMarker, type OnboardingGenerationRequest } from "../../core";

const MARKER = "<!-- ai-review:{repo}#{pr}@{head_sha} -->";

/** Deterministic prompt assembly from a ReviewInput (stable ordering for tests). */
export function buildReviewPrompt(input: ReviewInput): string {
  const { repo, pr, diff, context, output } = input;
  const marker = commentMarker(MARKER, repo.id, pr.number, pr.headSha);
  const s: string[] = [];

  s.push(
    `You are an autonomous pull-request reviewer for ${repo.id}. Review PR #${pr.number} ` +
      `"${pr.title}" at head ${pr.headSha} (base ${pr.baseSha}). You are running inside a checkout ` +
      `of the repo — read adjacent code as needed. In this codebase regressions usually come from ` +
      `breaking a cross-file contract, not a local syntax mistake. A good review is not style nits; ` +
      `it is "does this break correctness, privacy, security, or data provenance?"`,
  );

  if (context.repoGuideExcerpt) s.push(`## Repo guide\n${context.repoGuideExcerpt}`);

  if (context.subsystems.length) {
    s.push(
      `## Subsystem guides\n` +
        context.subsystems
          .map((g) => `### ${g.name} (${g.path}, risk: ${g.risk})\n${g.summary}`)
          .join("\n\n"),
    );
  }

  if (context.invariants.length) {
    s.push(
      `## Project invariants (violations are high-signal)\n` +
        context.invariants
          .map((i) => {
            const head = `- [${i.severity ?? "?"}] ${i.id}: ${i.rule}`;
            return i.reviewerQuestions.length ? `${head}\n  Ask: ${i.reviewerQuestions.join(" / ")}` : head;
          })
          .join("\n"),
    );
  }

  const sb = context.securityBaseline;
  s.push(
    `## Security / privacy / risk baseline (ALWAYS check)\n` +
      sb.alwaysCheck.map((c) => `- ${c}`).join("\n") +
      (sb.extra.length ? `\nRepo-specific:\n` + sb.extra.map((e) => `- ${e}`).join("\n") : "") +
      `\nSeverity floor: ${sb.severityFloor}.`,
  );

  const focus = [...new Set(context.profiles.flatMap((p) => p.focus))];
  s.push(
    `## Active review profiles\n${context.activeProfiles.join(", ")}` +
      (focus.length ? `\nFocus: ${focus.join(", ")}` : ""),
  );

  if (context.tests.length) {
    s.push(
      `## Relevant tests you may run (narrowest first)\n` +
        context.tests.map((t) => `- \`${t}\``).join("\n") +
        `\nRun them only if the change plausibly affects them; otherwise report them as not run.`,
    );
  }

  s.push(
    `## Diff (${diff.mode}, ${diff.fromSha}..${diff.toSha})\n` +
      `Changed files: ${diff.changedFiles
        .map((f) => `${f.path} (${f.status}, +${f.additions}/-${f.deletions})`)
        .join(", ")}\n\n` +
      "```diff\n" +
      diff.patch +
      "\n```",
  );

  s.push(outputContract(marker, output.commentTemplate, output.language));
  return s.join("\n\n");
}

/** Per-artifact schema hints the onboarding model must follow (only the requested targets are emitted). */
const ARTIFACT_SPECS: Record<string, string> = {
  repoGuide:
    `"repoGuide": a concise markdown string — product purpose, repo map (top-level dirs), architecture, ` +
    `conventions, and where deeper guides live. Ground every claim in real paths you read.`,
  subsystems:
    `"subsystems": array of { "name", "path", "summary", "risk": "low|medium|high", "body" } — one per ` +
    `significant top-level module. "name" is the last path segment; "body" is markdown detail.`,
  routing:
    `"routing": { "version":1, "defaults": { "mandatoryProfiles":["security-baseline"], "requiredContext":["AGENTS.md"] }, ` +
    `"routes":[{ "name", "paths":["glob/**"], "activateProfiles":["<profile>"] }], "notes":[] }. ADDITIVE: a PR ` +
    `activates the UNION of profiles from every matched route plus mandatoryProfiles. Reference ONLY profiles you ` +
    `also define in "profiles".`,
  profiles:
    `"profiles": { "profiles": { "<name>": { "depth":"shallow|normal|deep", "focus":["..."], "docs":["path"], ` +
    `"tests":["shell command"], "runTests":bool } } }. You MUST include a "security-baseline" profile. "tests" are ` +
    `narrow commands to run when active; prefer the repo's real test invocation.`,
  invariants:
    `"invariants": array of { "id":"kebab-id", "rule":"one sentence", "appliesTo":["glob/**"], ` +
    `"severity":"info|low|medium|high|critical", "reviewerQuestions":["..."], "body":"why it exists" }. These are ` +
    `PROPOSED rules a human will confirm — be precise and conservative; do not invent rules the code does not support.`,
};

/**
 * Onboarding generation prompt: hands the model the deterministic inventory + discovered docs and
 * asks it to author the requested pack artifacts as one strict JSON object (parsed by OnboardingArtifacts).
 * The model runs inside the checkout (read-only tools), so it reads adjacent code as needed.
 */
export function buildOnboardingPrompt(req: OnboardingGenerationRequest): string {
  const { repo, inventory, discovered, targets, language } = req;
  const s: string[] = [];

  s.push(
    `You are onboarding the repository ${repo} into an autonomous PR-review platform. Produce a reusable ` +
      `"context pack" the reviewer will consult on every PR. You are running inside a checkout — read files ` +
      `as needed, but PREFER the inventory and discovered docs below over exhaustive reading (keep this cheap). ` +
      `A good pack is specific and grounded: real paths, real invariants, no generic filler.`,
  );

  s.push(
    `## Inventory (detected deterministically)\n` +
      `- Languages: ${inventory.languages.join(", ") || "?"}\n` +
      `- Frameworks: ${inventory.frameworks.join(", ") || "?"}\n` +
      `- Package managers: ${inventory.packageManagers.join(", ") || "?"}\n` +
      `- CI: ${inventory.ci.join(", ") || "?"}\n` +
      `- Test: ${inventory.test.framework ?? "?"}${inventory.test.command ? ` (\`${inventory.test.command}\`)` : ""}\n` +
      `- Entrypoints: ${inventory.entrypoints.join(", ") || "?"}\n` +
      `- Modules: ${inventory.modules.map((m) => `${m.path} (risk ${m.risk})`).join(", ") || "?"}`,
  );

  if (discovered.length) {
    s.push(
      `## Discovered existing context (read these first; cite them)\n` +
        discovered
          .map((d) => `### ${d.path} (${d.type})\n${d.excerpt.slice(0, 1200)}`)
          .join("\n\n"),
    );
  }

  s.push(
    `## Artifacts to produce (emit ONLY these keys)\n` +
      targets.map((t) => `- ${ARTIFACT_SPECS[t] ?? `"${t}"`}`).join("\n"),
  );

  s.push(
    `## Output contract (STRICT)\n` +
      `Do NOT write any files. Your FINAL message must be exactly ONE JSON object and nothing else, with ` +
      `exactly these top-level keys: ${targets.map((t) => `"${t}"`).join(", ")}.\n` +
      `Markdown prose (repoGuide, subsystem summaries/bodies) must be in ${language === "ru" ? "Russian" : "English"}; ` +
      `ids, globs, and code stay in English. If you cannot justify an invariant from the code, omit it rather than guess.`,
  );

  return s.join("\n\n");
}

function outputContract(marker: string, template: string, language: string): string {
  const lines = [
    `## Output contract (STRICT)`,
    `Do NOT post anything yourself. Your FINAL message must be exactly ONE JSON object and nothing else:`,
    "```json",
    `{`,
    `  "status": "ok" | "skipped",`,
    `  "comment": "<the PR comment as a single markdown string>",`,
    `  "findings": [{ "title": "...", "severity": "info|low|medium|high|critical", "file": "path", "line": 1, "category": "...", "detail": "..." }],`,
    `  "residualRisk": "<what you could not verify>"`,
    `}`,
    "```",
    `The "comment" must be in ${language === "ru" ? "Russian" : "English"}, order findings by severity ` +
      `(privacy > historical correctness > identity/provenance > auth/session > other), state which tests ` +
      `you ran vs did NOT run, and END with this exact hidden marker on its own line:`,
    marker,
    template ? `Follow this comment template:\n${template}` : "",
    `If there are no actionable findings, set status "ok" and say so plainly with residual risk. ` +
      `Never invent certainty; if a test was not run, say so.`,
  ];
  return lines.filter(Boolean).join("\n");
}
