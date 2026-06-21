/* Worker — drains the durable queue, running each job through the review pipeline. */
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { loadPlatformConfig } from "../../config";
import { createStores } from "../../store";
import { createLogger } from "../../telemetry";
import { composeReviewDeps } from "../../compose";
import { drainQueue } from "./loop";

async function main(): Promise<void> {
  const platformPath = existsSync("./config/platform.yaml")
    ? "./config/platform.yaml"
    : "./config/platform.example.yaml";
  const platform = loadPlatformConfig(platformPath);
  mkdirSync(dirname(platform.dbPath), { recursive: true });

  const { queue } = createStores(platform.dbPath);
  const logger = createLogger("worker", platform.logLevel);

  // Jobs are enqueued by ingress (M6) / reconciler (M7); here we drain whatever is queued.
  const processed = await drainQueue(queue, (repo) => composeReviewDeps(repo, { prNumber: 0 }).deps);
  logger.info(`drained ${processed} job(s)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
