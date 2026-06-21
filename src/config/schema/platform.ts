import { z } from "zod";

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
});
export type PlatformConfig = z.infer<typeof PlatformConfig>;
