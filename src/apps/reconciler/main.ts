/* Reconciler — completeness guarantee: periodically sweep open PRs, enqueue + drain
   any head SHA without a successful review. Needs GITHUB_TOKEN. */
import { composePlatform } from "../../compose";
import { reconcile } from "./reconcile";

async function main(): Promise<void> {
  const p = composePlatform();
  const everyMs = Math.max(0.1, p.platform.reconciler.everyHours) * 3_600_000;

  const tick = async (): Promise<void> => {
    try {
      const r = await reconcile(p, {});
      p.logger.info(
        `reconcile: scanned ${r.scanned} PR(s), uncovered ${r.uncovered.length}, ` +
          `enqueued ${r.enqueued}, processed ${r.processed}`,
      );
    } catch (e) {
      p.logger.error(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (p.platform.reconciler.onStart) await tick();
  setInterval(() => void tick(), everyMs);
  p.logger.info(`reconciler running; sweep every ${p.platform.reconciler.everyHours}h`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
