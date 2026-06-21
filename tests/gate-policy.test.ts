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
});
