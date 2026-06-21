import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveredDoc } from "../core";
import { walkFiles, readExcerpt } from "./fs-scan";

/** Structured view of the existing in-repo context an onboarding run can ingest or learn from. */
export interface Discovery {
  /** Flat list of everything found (path + type + short excerpt) — surfaced in OnboardingResult. */
  found: DiscoveredDoc[];
  rootAgents?: DiscoveredDoc;
  claudeMd?: DiscoveredDoc;
  readme?: DiscoveredDoc;
  contributing?: DiscoveredDoc;
  cursorRules?: DiscoveredDoc;
  /** Non-root AGENTS.md files — each becomes a subsystem guide. */
  nestedAgents: DiscoveredDoc[];
  /** kourion-style reviewer layer (NOT our schema — feeds generation, not direct ingest). */
  reviewerRouting?: DiscoveredDoc;
  reviewerProfiles: DiscoveredDoc[];
  commentTemplate?: DiscoveredDoc;
  securityDoc?: DiscoveredDoc;
  /** Long-form invariant docs (docs/invariants/*.md). */
  invariantDocs: DiscoveredDoc[];
  adrs: DiscoveredDoc[];
  /** Existing pack-format artifacts already present in the checkout (re-adopt as-is). */
  ourSchema: {
    routing?: DiscoveredDoc;
    profiles?: DiscoveredDoc;
    invariants?: DiscoveredDoc;
    securityBaseline?: DiscoveredDoc;
    subsystems: DiscoveredDoc[];
  };
}

function doc(root: string, rel: string, type: string): DiscoveredDoc {
  return { path: rel, type, excerpt: readExcerpt(root, rel) };
}

/** First matching path from candidates (relative), or undefined. */
function firstExisting(root: string, candidates: string[]): string | undefined {
  return candidates.find((c) => existsSync(join(root, c)));
}

function listMd(root: string, dir: string, type: string): DiscoveredDoc[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  try {
    return readdirSync(full)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => doc(root, `${dir}/${f}`, type));
  } catch {
    return [];
  }
}

/**
 * Scan the checkout for existing context: README, CLAUDE.md, the AGENTS.md hierarchy,
 * a docs/reviewer/ layer, docs/invariants/, ADRs, and any already-normalized pack files.
 * Deterministic and cheap (filename + bounded excerpt reads only).
 */
export function discoverContext(repoDir: string): Discovery {
  const files = walkFiles(repoDir);
  const found: DiscoveredDoc[] = [];
  const add = (d: DiscoveredDoc | undefined): DiscoveredDoc | undefined => {
    if (d) found.push(d);
    return d;
  };

  const readmeRel = firstExisting(repoDir, ["README.md", "README", "readme.md", "Readme.md"]);
  const readme = add(readmeRel ? doc(repoDir, readmeRel, "readme") : undefined);

  const rootAgents = add(existsSync(join(repoDir, "AGENTS.md")) ? doc(repoDir, "AGENTS.md", "agents") : undefined);
  const claudeMd = add(existsSync(join(repoDir, "CLAUDE.md")) ? doc(repoDir, "CLAUDE.md", "claude") : undefined);

  const contribRel = firstExisting(repoDir, ["CONTRIBUTING.md", "CONTRIBUTING", ".github/CONTRIBUTING.md"]);
  const contributing = add(contribRel ? doc(repoDir, contribRel, "contributing") : undefined);
  const cursorRules = add(existsSync(join(repoDir, ".cursorrules")) ? doc(repoDir, ".cursorrules", "cursorrules") : undefined);

  // Nested AGENTS.md (anything but the root file) -> subsystem guides.
  const nestedAgents = files
    .filter((f) => f.endsWith("/AGENTS.md") && f !== "AGENTS.md")
    .sort()
    .map((f) => doc(repoDir, f, "agents-nested"));
  for (const d of nestedAgents) found.push(d);

  // kourion-style reviewer layer.
  const reviewerRouting = add(
    existsSync(join(repoDir, "docs/reviewer/routing.yaml")) ? doc(repoDir, "docs/reviewer/routing.yaml", "reviewer-routing") : undefined,
  );
  const reviewerProfiles = listMd(repoDir, "docs/reviewer/profiles", "reviewer-profile");
  for (const d of reviewerProfiles) found.push(d);
  const securityDoc = reviewerProfiles.find((d) => /security-baseline\.md$/.test(d.path));
  const ctRel = firstExisting(repoDir, ["docs/reviewer/comment-template.md", ".github/PULL_REQUEST_TEMPLATE.md"]);
  const commentTemplate = add(ctRel ? doc(repoDir, ctRel, "comment-template") : undefined);

  const invariantDocs = listMd(repoDir, "docs/invariants", "invariant-doc");
  for (const d of invariantDocs) found.push(d);

  const adrs = [...listMd(repoDir, "docs/adr", "adr"), ...listMd(repoDir, "docs/adrs", "adr"), ...listMd(repoDir, "docs/decisions", "adr")];
  for (const d of adrs) found.push(d);

  // Already-normalized pack artifacts living in the repo (rare; lets a repo adopt our format).
  const ourBase = "docs/context-pack";
  const ourSchema = {
    routing: existsSync(join(repoDir, `${ourBase}/routing.yaml`)) ? doc(repoDir, `${ourBase}/routing.yaml`, "pack-routing") : undefined,
    profiles: existsSync(join(repoDir, `${ourBase}/profiles.yaml`)) ? doc(repoDir, `${ourBase}/profiles.yaml`, "pack-profiles") : undefined,
    invariants: existsSync(join(repoDir, `${ourBase}/invariants.yaml`)) ? doc(repoDir, `${ourBase}/invariants.yaml`, "pack-invariants") : undefined,
    securityBaseline: existsSync(join(repoDir, `${ourBase}/security-baseline.yaml`))
      ? doc(repoDir, `${ourBase}/security-baseline.yaml`, "pack-security")
      : undefined,
    subsystems: listMd(repoDir, `${ourBase}/subsystems`, "pack-subsystem"),
  };
  for (const d of [ourSchema.routing, ourSchema.profiles, ourSchema.invariants, ourSchema.securityBaseline, ...ourSchema.subsystems]) {
    if (d) found.push(d);
  }

  return {
    found,
    rootAgents,
    claudeMd,
    readme,
    contributing,
    cursorRules,
    nestedAgents,
    reviewerRouting,
    reviewerProfiles,
    commentTemplate,
    securityDoc,
    invariantDocs,
    adrs,
    ourSchema,
  };
}

/** Subsystem name from a nested AGENTS.md path: the last segment of its directory. */
export function subsystemNameFromAgents(rel: string): { name: string; path: string } {
  const dir = rel.replace(/\/AGENTS\.md$/, "");
  const name = dir.split("/").pop() || dir;
  return { name, path: dir };
}
