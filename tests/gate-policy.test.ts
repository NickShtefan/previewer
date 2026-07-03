import { describe, it, expect } from "vitest";
import { gate } from "../src/apps/worker/gate";
import { changeSignals, selectRunnerSelector } from "../src/apps/worker/policy";
import { RepoConfig } from "../src/config";
import type { ChangedFile, ResolvedContext } from "../src/config";

const cf = (path: string, adds = 3, dels = 1): ChangedFile => ({
  path,
  status: "modified",
  additions: adds,
  deletions: dels,
  sizeClass: "small",
});

const resolved = (invariants: ResolvedContext["invariants"]): ResolvedContext => ({
  packVersion: "context-pack@v1",
  repoGuideExcerpt: "",
  subsystems: [],
  invariants,
  securityBaseline: { alwaysCheck: [], severityFloor: "medium", extra: [] },
  commentTemplate: "",
  activeProfiles: [],
  profiles: [],
  tests: [],
  requiredDocs: [],
  riskMap: [],
});

describe("gate", () => {
  it("skips empty and ignored-only changes, reviews otherwise", () => {
    expect(gate({ changedFiles: [], ignorePaths: [] }).action).toBe("skip");
    expect(gate({ changedFiles: [cf("a.lock")], ignorePaths: ["**/*.lock"] }).action).toBe("skip");
    expect(gate({ changedFiles: [cf("src/x.ts")], ignorePaths: ["**/*.lock"] }).action).toBe("review");
  });
});

describe("changeSignals", () => {
  it("infers change type", () => {
    expect(changeSignals([cf("api/prisma/migrations/x.sql")], resolved([])).changeType).toBe("migration");
    expect(changeSignals([cf("docs/a.md"), cf("b.md")], resolved([])).changeType).toBe("docs");
    expect(changeSignals([cf("pnpm-lock.yaml")], resolved([])).changeType).toBe("deps");
    expect(changeSignals([cf("src/x.ts")], resolved([])).changeType).toBe("other");
  });

  it("derives risk from invariant severity", () => {
    const high = [
      { id: "i", rule: "r", appliesTo: ["**"], status: "confirmed" as const, severity: "high" as const, reviewerQuestions: [], body: "" },
    ];
    expect(changeSignals([cf("src/x.ts")], resolved(high)).risk).toBe("high");
    expect(changeSignals([cf("src/x.ts")], resolved([])).risk).toBe("low");
  });
});

describe("selectRunnerSelector", () => {
  const cfg = RepoConfig.parse({
    repo: { id: "o/r" },
    runner: { default: "claude-cli", overrides: [{ when: { changeType: "migration" }, use: "deep-runner" }] },
  });

  it("uses a matching override, else the default", () => {
    expect(selectRunnerSelector(cfg, { changeType: "migration", size: "small", risk: "high" }).preferred).toBe("deep-runner");
    expect(selectRunnerSelector(cfg, { changeType: "other", size: "small", risk: "low" }).preferred).toBe("claude-cli");
  });

  it("resolves default-level model and reasoningEffort into the selector", () => {
    const withDefaults = RepoConfig.parse({
      repo: { id: "o/r" },
      runner: { default: "claude-cli", model: "claude-opus-4-8", reasoningEffort: "high" },
    });
    const sel = selectRunnerSelector(withDefaults, { changeType: "other", size: "small", risk: "low" });
    expect(sel.preferred).toBe("claude-cli");
    expect(sel.model).toBe("claude-opus-4-8");
    expect(sel.reasoningEffort).toBe("high");
  });

  it("resolves a matching override's model and reasoningEffort", () => {
    const withOverride = RepoConfig.parse({
      repo: { id: "o/r" },
      runner: {
        default: "claude-cli",
        model: "claude-sonnet-5",
        overrides: [{ when: { risk: "high" }, use: "codex-cli", model: "gpt-5-codex", reasoningEffort: "high" }],
      },
    });
    const hit = selectRunnerSelector(withOverride, { changeType: "feature", size: "large", risk: "high" });
    expect(hit.preferred).toBe("codex-cli");
    expect(hit.model).toBe("gpt-5-codex");
    expect(hit.reasoningEffort).toBe("high");
    // A non-matching signal falls back to the default runner's model, and clears the override effort.
    const miss = selectRunnerSelector(withOverride, { changeType: "feature", size: "small", risk: "low" });
    expect(miss.preferred).toBe("claude-cli");
    expect(miss.model).toBe("claude-sonnet-5");
    expect(miss.reasoningEffort).toBeUndefined();
  });
});
