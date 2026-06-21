/* Admin CLI — the control-plane surface. */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { composeReviewDeps, composePlatform, composeOnboarding } from "../../compose";
import { reviewPipeline, type PipelineOutcome } from "../worker/pipeline";
import { reconcile } from "../reconciler/reconcile";
import { ensureDefaultCheckout } from "../../github";
import { OnboardingInput, type OnboardingResult } from "../../config";

const HELP = `previewer — AI PR review orchestrator (CLI)

Usage: npm run cli -- <command> [args]

Commands:
  review <owner/repo> <pr> [flags]   Review a PR's current head SHA
    --dry-run            print the review, do not post a comment
    --local <path>       use a local checkout (non-destructive worktree)
    --head <sha>         PR head SHA (offline; skips the GitHub API)
    --base <sha|ref>     diff base (default: repo default branch)
    --token <pat>        GitHub token (or env GITHUB_TOKEN)
    --runner <id>        engine: claude-cli (default) | codex-cli
    --force              re-review even if this head SHA was already reviewed
  onboard <owner/repo> [flags]       Build a repo's context pack
    --local <path>       onboard a local checkout (offline; no GitHub token)
    --threshold <0..1>   use-existing score to ingest an artifact (default 0.7)
    --confirm-invariants approve generated invariants in this run
    --runner <id>        generation engine: claude-cli (default) | codex-cli
    --model <id>         model for generation (default: subscription default)
    --dry-run            compute + print the pack, do not write it
  reconcile-now [--dry-run] [--enqueue-only]   Sweep open PRs -> review missing SHAs
  inspect [owner/repo]               Show recent review runs and costs      [M9]
  help                               Show this help

First offline run (only needs Claude Code on your subscription + a local checkout):
  npm run cli -- review NickShtefan/kourion.fi 312 --dry-run \\
    --local /Users/you/Projects/CODE/kourion.fi --head <head-sha>`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a !== undefined && a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else if (a !== undefined) {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

function printOutcome(repo: string, prNumber: number, o: PipelineOutcome): void {
  switch (o.status) {
    case "dry-run":
      if (o.result.status === "error") {
        console.error(
          `Dry-run produced no review — runner "${o.result.meta.runnerId}" error: ${o.result.error?.message ?? "unknown"}`,
        );
        process.exitCode = 1;
        break;
      }
      console.log(`\n=== DRY RUN — ${repo}#${prNumber} ===\n`);
      console.log(o.result.comment?.bodyMarkdown ?? "(no comment produced)");
      console.log(
        `\n--- ${o.result.meta.model} · ${o.result.meta.tokensIn}->${o.result.meta.tokensOut} tok ` +
          `· $${o.result.meta.usd} · ${o.result.findings.length} finding(s) ---`,
      );
      break;
    case "reviewed":
      console.log(
        `Reviewed ${repo}#${prNumber}: comment #${o.commentId} ` +
          `(${o.result.findings.length} findings, ${o.result.meta.tokensIn}->${o.result.meta.tokensOut} tok, $${o.result.meta.usd}).`,
      );
      break;
    case "duplicate":
      console.log("Already reviewed this head SHA (dedupe). Re-run with --force to review it again.");
      break;
    case "skipped":
      console.log(`Skipped: ${o.reason}`);
      break;
    case "error":
      console.error(`Error: ${o.message}${o.retriable ? " (retriable)" : ""}`);
      break;
  }
}

async function review(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [repo, prStr] = positional;
  if (!repo || !prStr) {
    console.error("usage: review <owner/repo> <pr> [--dry-run] [--local <path>] [--head <sha>] [--base <sha>] [--token <pat>] [--force]");
    process.exitCode = 1;
    return;
  }
  const prNumber = Number(prStr);
  const dryRun = Boolean(flags["dry-run"]);
  const force = Boolean(flags.force);

  const { deps, db } = composeReviewDeps(repo, {
    prNumber,
    dryRun,
    local: str(flags.local),
    head: str(flags.head),
    base: str(flags.base),
    token: str(flags.token),
  });
  try {
    const outcome = await reviewPipeline(deps, { repo, prNumber, dryRun, force, runner: str(flags.runner) });
    printOutcome(repo, prNumber, outcome);
    if (outcome.status === "error") process.exitCode = 1;
  } finally {
    db.close();
  }
}

function printOnboarding(result: OnboardingResult, persisted: boolean): void {
  const inv = result.inventory;
  console.log(`\n=== ONBOARD ${result.repo} -> ${result.contextPack.ref} (${result.status}) ===\n`);
  console.log(`Languages: ${inv.languages.join(", ") || "?"}`);
  console.log(`Frameworks: ${inv.frameworks.join(", ") || "?"}`);
  console.log(`Package managers: ${inv.packageManagers.join(", ") || "?"}`);
  console.log(`CI: ${inv.ci.join(", ") || "?"}`);
  console.log(`Test: ${inv.test.framework ?? "?"}${inv.test.command ? ` (${inv.test.command})` : ""}`);
  console.log(`Modules: ${inv.modules.map((m) => `${m.path}[${m.risk}]`).join(", ") || "?"}`);

  console.log(`\nExisting context found: ${result.existingContext.found.length} doc(s)`);
  for (const f of result.existingContext.found.slice(0, 20)) console.log(`  - ${f.path} (${f.type})`);

  console.log(`\nArtifact decisions:`);
  for (const [artifact, decision] of Object.entries(result.contextPack.decisions)) {
    console.log(`  - ${artifact}: ${decision}`);
  }

  if (result.openQuestions.length) {
    console.log(`\nNeeds confirmation (${result.openQuestions.length}):`);
    for (const q of result.openQuestions) console.log(`  • ${q}`);
    console.log(`\nApprove with: npm run cli -- onboard ${result.repo} --local <path> --confirm-invariants`);
  }

  console.log(`\nCost: ${result.cost.tokens} tok · $${result.cost.usd}`);
  console.log(persisted ? `Pack written. Status: ${result.status}.` : `(dry-run — nothing written.)`);
}

async function onboard(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [repo] = positional;
  if (!repo) {
    console.error("usage: onboard <owner/repo> [--local <path>] [--threshold <n>] [--confirm-invariants] [--model <id>] [--dry-run]");
    process.exitCode = 1;
    return;
  }
  const local = str(flags.local);
  const dryRun = Boolean(flags["dry-run"]);
  const thresholdStr = str(flags.threshold);
  const threshold = thresholdStr !== undefined ? Number(thresholdStr) : undefined;
  if (threshold !== undefined && (Number.isNaN(threshold) || threshold < 0 || threshold > 1)) {
    console.error("--threshold must be a number in [0, 1].");
    process.exitCode = 1;
    return;
  }

  const { pipeline, workspacesDir } = composeOnboarding({ model: str(flags.model), runner: str(flags.runner) });

  // Acquire a checkout: local path directly (read-only), or clone the default branch.
  let workspaceDir: string;
  if (local) {
    workspaceDir = resolve(local);
    if (!existsSync(workspaceDir)) {
      console.error(`--local path does not exist: ${workspaceDir}`);
      process.exitCode = 1;
      return;
    }
  } else {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const url = token ? `https://x-access-token:${token}@github.com/${repo}.git` : `https://github.com/${repo}.git`;
    const dir = `${workspacesDir}/${repo.replace("/", "__")}__onboard`;
    console.log(`Cloning ${repo} (default branch) -> ${dir} ...`);
    await ensureDefaultCheckout(url, dir);
    workspaceDir = dir;
  }

  const input = OnboardingInput.parse({
    repo,
    workspaceDir,
    ...(threshold !== undefined ? { useExistingThreshold: threshold } : {}),
  });
  const result = await pipeline.run(input, {
    persist: !dryRun,
    confirmInvariants: Boolean(flags["confirm-invariants"]),
  });
  printOnboarding(result, !dryRun);
  if (result.status === "failed") process.exitCode = 1;
}

async function reconcileNow(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const dryRun = Boolean(flags["dry-run"]);
  const enqueueOnly = Boolean(flags["enqueue-only"]);
  const p = composePlatform({ token: str(flags.token) });
  try {
    const r = await reconcile(p, { dryRun, process: !enqueueOnly });
    console.log(`Scanned ${r.scanned} open PR(s) across ${r.repos} repo(s) — ${r.uncovered.length} uncovered.`);
    for (const u of r.uncovered) console.log(`  - ${u.repo}#${u.prNumber} — ${u.title.slice(0, 70)}`);
    if (dryRun) console.log("(dry-run — nothing enqueued or reviewed)");
    else console.log(`Enqueued ${r.enqueued}, processed ${r.processed}.`);
  } finally {
    p.db.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "review":
      await review(rest);
      return;
    case "reconcile-now":
      await reconcileNow(rest);
      return;
    case "onboard":
      await onboard(rest);
      return;
    case "inspect":
      console.error(`Command "${cmd}" is scaffolded but not implemented yet (see docs/MILESTONES.md).`);
      process.exitCode = 1;
      return;
    case "help":
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
