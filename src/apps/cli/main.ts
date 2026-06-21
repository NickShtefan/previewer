/* Admin CLI — the control-plane surface. */
import { composeReviewDeps, composePlatform } from "../../compose";
import { reviewPipeline, type PipelineOutcome } from "../worker/pipeline";
import { reconcile } from "../reconciler/reconcile";

const HELP = `previewer — AI PR review orchestrator (CLI)

Usage: npm run cli -- <command> [args]

Commands:
  review <owner/repo> <pr> [flags]   Review a PR's current head SHA
    --dry-run            print the review, do not post a comment
    --local <path>       use a local checkout (non-destructive worktree)
    --head <sha>         PR head SHA (offline; skips the GitHub API)
    --base <sha|ref>     diff base (default: repo default branch)
    --token <pat>        GitHub token (or env GITHUB_TOKEN)
    --force              re-review even if this head SHA was already reviewed
  onboard <owner/repo>               Build a repo's context pack            [M8]
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
    const outcome = await reviewPipeline(deps, { repo, prNumber, dryRun, force });
    printOutcome(repo, prNumber, outcome);
    if (outcome.status === "error") process.exitCode = 1;
  } finally {
    db.close();
  }
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
