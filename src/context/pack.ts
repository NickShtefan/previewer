import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigError } from "../core";
import {
  ContextPack,
  PackManifest,
  Routing,
  Profiles,
  Invariants,
  SecurityBaseline,
  RiskMap,
  SubsystemGuide,
} from "../config";

const read = (dir: string, f: string): string => readFileSync(join(dir, f), "utf8");

function parseSubsystemGuide(name: string, content: string): SubsystemGuide {
  const pathM = content.match(/\*\*Path:\*\*\s*`([^`]+)`/);
  const riskM = content.match(/\*\*Risk:\*\*\s*(low|medium|high)/i);
  const summary =
    content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("**Path") && !l.startsWith("**Risk")) ?? "";
  return SubsystemGuide.parse({
    name,
    path: pathM?.[1] ?? name,
    summary,
    risk: riskM?.[1]?.toLowerCase() ?? "medium",
    body: content,
  });
}

function loadSubsystems(dir: string): SubsystemGuide[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseSubsystemGuide(f.replace(/\.md$/, ""), read(dir, f)));
}

/**
 * Load + validate a context pack from a `context-pack/` directory and assemble it
 * into a single in-memory ContextPack. Throws ConfigError on a missing required
 * artifact, a zod failure, or a route that references an undefined profile.
 */
export function loadPack(packDir: string, repoId: string): ContextPack {
  let manifest: PackManifest;
  let routing: Routing;
  let profiles: Profiles;
  let invariants: Invariants;
  let securityBaseline: SecurityBaseline;
  try {
    manifest = PackManifest.parse(parseYaml(read(packDir, "manifest.yaml")));
    routing = Routing.parse(parseYaml(read(packDir, "routing.yaml")));
    profiles = Profiles.parse(parseYaml(read(packDir, "profiles.yaml")));
    invariants = Invariants.parse(parseYaml(read(packDir, "invariants.yaml")));
    securityBaseline = SecurityBaseline.parse(parseYaml(read(packDir, "security-baseline.yaml")));
  } catch (e) {
    throw new ConfigError(`Invalid context pack at ${packDir}: ${(e as Error).message}`);
  }

  const repoGuide = existsSync(join(packDir, "repo-guide.md")) ? read(packDir, "repo-guide.md") : "";
  const commentTemplate = existsSync(join(packDir, "comment-template.md"))
    ? read(packDir, "comment-template.md")
    : "";
  const subsystems = loadSubsystems(join(packDir, "subsystems"));
  const riskMap = existsSync(join(packDir, "risk-map.yaml"))
    ? RiskMap.parse(parseYaml(read(packDir, "risk-map.yaml")))
    : { entries: [] };

  // Consistency: every referenced profile must be defined.
  for (const route of routing.routes) {
    for (const p of route.activateProfiles) {
      if (!profiles.profiles[p]) {
        throw new ConfigError(`routing route "${route.name}" references unknown profile "${p}"`);
      }
    }
  }
  for (const p of routing.defaults.mandatoryProfiles) {
    if (!profiles.profiles[p]) {
      throw new ConfigError(`mandatory profile "${p}" is not defined in profiles.yaml`);
    }
  }

  return ContextPack.parse({
    repo: repoId,
    manifest,
    repoGuide,
    subsystems,
    routing,
    profiles,
    invariants,
    securityBaseline,
    commentTemplate,
    riskMap,
  });
}
