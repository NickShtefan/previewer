import type { ReviewInput } from "../../config";
import { commentMarker } from "../../core";

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
