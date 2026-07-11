import { z } from "zod";
import { RunnerProfiles, DEFAULT_RUNNER_PROFILES } from "./runner";

/** Global platform configuration (`config/platform.yaml`). */
export const PlatformConfig = z.object({
  dataDir: z.string().default("./data"),
  dbPath: z.string().default("./data/orchestrator.db"),
  reposDir: z.string().default("./config/repos"),
  workspacesDir: z.string().default("./data/workspaces"),
  defaultLanguage: z.enum(["ru", "en"]).default("en"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  reconciler: z
    .object({
      onStart: z.boolean().default(true),
      everyHours: z.number().positive().default(6),
    })
    .default({}),
  github: z
    .object({
      appId: z.string().optional(),
      privateKeyPath: z.string().optional(),
      webhookSecretEnv: z.string().default("GITHUB_WEBHOOK_SECRET"),
    })
    .default({}),
  /**
   * Named runner profiles: `{ runner, model, reasoningEffort }` bundles keyed by name. A repo picks
   * its active review client via `runner.profile: <name>` (see config/schema/repo.ts). Defaults to
   * the built-in starter set so profiles exist even when this file omits the key; override the whole
   * map here to add/replace clients.
   */
  runnerProfiles: RunnerProfiles.default(DEFAULT_RUNNER_PROFILES),
});
export type PlatformConfig = z.infer<typeof PlatformConfig>;
