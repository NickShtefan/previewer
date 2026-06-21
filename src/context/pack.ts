import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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

export function parseSubsystemGuide(name: string, content: string): SubsystemGuide {
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

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** A YAML file with a one-line provenance comment header. */
function yamlDoc(header: string, obj: unknown): string {
  return `# ${header}\n${stringifyYaml(obj)}`;
}

const ensureNl = (s: string): string => (s.endsWith("\n") || s === "" ? s : s + "\n");

/** kebab-ish filename for a subsystem (mirrors how loadPack derives the name from the filename). */
function subsystemSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "subsystem";
}

/**
 * Serialize a SubsystemGuide to the markdown shape `parseSubsystemGuide` reads back
 * (a `**Path:**`/`**Risk:**` header + summary). If the body already is a complete
 * `# Subsystem:` doc (e.g. an ingested one), write it verbatim for an exact round-trip.
 */
function subsystemMarkdown(g: SubsystemGuide): string {
  if (g.body.trimStart().startsWith("# Subsystem:")) return ensureNl(g.body);
  const head = `# Subsystem: ${g.name}\n\n**Path:** \`${g.path}\` · **Risk:** ${g.risk}\n\n${g.summary}`;
  return ensureNl(g.body ? `${head}\n\n${g.body}` : head);
}

/**
 * Inverse of {@link loadPack}: write a ContextPack to a `context-pack/` directory as the
 * on-disk artifacts (YAML + markdown), recompute the manifest's per-artifact sha256s, and
 * write `manifest.yaml`. Returns the written manifest. Stale subsystem files and a dropped
 * `risk-map.yaml` are removed so re-onboarding never leaves orphans.
 */
export function writePack(packDir: string, pack: ContextPack): PackManifest {
  mkdirSync(packDir, { recursive: true });
  const subsystemsDir = join(packDir, "subsystems");
  rmSync(subsystemsDir, { recursive: true, force: true });

  const artifacts: Array<{ path: string; sha256: string }> = [];
  const put = (rel: string, content: string): void => {
    const full = join(packDir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
    artifacts.push({ path: rel, sha256: sha256(content) });
  };

  put("repo-guide.md", ensureNl(pack.repoGuide));
  put("routing.yaml", yamlDoc("Additive routing — UNION of matched profiles + mandatoryProfiles.", pack.routing));
  put("profiles.yaml", yamlDoc("Review profiles — each bundles docs + tests.", pack.profiles));
  put("invariants.yaml", yamlDoc("Project invariants — generated ones stay needs_confirmation until approved.", pack.invariants));
  put("security-baseline.yaml", yamlDoc("Mandatory security/privacy lens, applied to every PR.", pack.securityBaseline));
  put("comment-template.md", ensureNl(pack.commentTemplate));
  for (const s of [...pack.subsystems].sort((a, b) => a.name.localeCompare(b.name))) {
    put(`subsystems/${subsystemSlug(s.name)}.md`, subsystemMarkdown(s));
  }
  const riskMapPath = join(packDir, "risk-map.yaml");
  if (pack.riskMap.entries.length) put("risk-map.yaml", yamlDoc("Per-area risk + tests to run.", pack.riskMap));
  else rmSync(riskMapPath, { force: true });

  const manifest = PackManifest.parse({
    version: pack.manifest.version,
    generatedAt: pack.manifest.generatedAt,
    provenance: pack.manifest.provenance,
    artifacts,
  });
  writeFileSync(join(packDir, "manifest.yaml"), yamlDoc("Pack manifest — per-artifact provenance + sha256.", manifest));
  return manifest;
}
