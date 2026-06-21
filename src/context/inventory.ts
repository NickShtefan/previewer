import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Inventory, type Module, type RiskLevel } from "../config";
import { languageOf } from "../github";
import { walkFiles, readMaybe } from "./fs-scan";

/** Languages we don't surface as "the repo's languages" (markup / data / docs). */
const NON_CODE_LANGS = new Set(["markdown", "json", "yaml", "toml", "text"]);

/** Lockfile basename -> package manager. */
const LOCKFILES: Record<string, string> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "yarn.lock": "yarn",
  "pnpm-lock.yaml": "pnpm",
  "bun.lockb": "bun",
  "go.sum": "go-modules",
  "Cargo.lock": "cargo",
  "poetry.lock": "poetry",
  "Pipfile.lock": "pipenv",
  "composer.lock": "composer",
  "Gemfile.lock": "bundler",
};

/** Manifest-only signals (no lockfile) -> package manager. */
const MANIFESTS: Record<string, string> = {
  "go.mod": "go-modules",
  "Cargo.toml": "cargo",
  "requirements.txt": "pip",
  "pyproject.toml": "pip",
  "Gemfile": "bundler",
  "composer.json": "composer",
};

/** Dependency-name substring -> framework label (matched against package.json deps). */
const JS_FRAMEWORKS: Array<[RegExp, string]> = [
  [/^next$/, "next"], [/^react$/, "react"], [/^react-native$/, "react-native"],
  [/^vue$/, "vue"], [/^nuxt$/, "nuxt"], [/^svelte$/, "svelte"], [/^@sveltejs\/kit$/, "sveltekit"],
  [/^@angular\/core$/, "angular"], [/^solid-js$/, "solid"], [/^astro$/, "astro"],
  [/^express$/, "express"], [/^fastify$/, "fastify"], [/^@nestjs\/core$/, "nestjs"],
  [/^koa$/, "koa"], [/^hono$/, "hono"], [/^@hapi\/hapi$/, "hapi"],
  [/^vite$/, "vite"], [/^webpack$/, "webpack"], [/^@remix-run\//, "remix"],
  [/^prisma$|^@prisma\/client$/, "prisma"], [/^typeorm$/, "typeorm"], [/^drizzle-orm$/, "drizzle"],
  [/^electron$/, "electron"], [/^@tanstack\/react-query$/, "react-query"],
];

const PY_FRAMEWORKS: Array<[RegExp, string]> = [
  [/django/i, "django"], [/flask/i, "flask"], [/fastapi/i, "fastapi"],
  [/pydantic/i, "pydantic"], [/sqlalchemy/i, "sqlalchemy"],
];

/** JS test runner detected in deps -> [framework, command]. */
const JS_TEST_RUNNERS: Array<[RegExp, string]> = [
  [/^vitest$/, "vitest"], [/^jest$/, "jest"], [/^mocha$/, "mocha"],
  [/^ava$/, "ava"], [/^@playwright\/test$/, "playwright"], [/^cypress$/, "cypress"],
  [/^node:test$|^tap$/, "tap"],
];

const CI_SIGNALS: Array<[string, string]> = [
  [".github/workflows", "github-actions"],
  [".gitlab-ci.yml", "gitlab-ci"],
  [".circleci/config.yml", "circleci"],
  ["azure-pipelines.yml", "azure-pipelines"],
  ["Jenkinsfile", "jenkins"],
  [".travis.yml", "travis"],
  ["bitbucket-pipelines.yml", "bitbucket-pipelines"],
  [".drone.yml", "drone"],
];

/** Directory-name heuristics for module risk (no model). */
const HIGH_RISK = /(^|[-_])(auth|secur|payment|billing|crypto|wallet|token|admin|api|server|backend|db|database|migrat|infra|deploy|core|services?)([-_]|$)/i;
const LOW_RISK = /(^|[-_])(docs?|examples?|samples?|scripts?|tests?|specs?|fixtures?|mocks?|assets?|static|public|styles?|stories|e2e|bench|tools)([-_]|$)/i;

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Collect package.json files at depth 0 and 1 (monorepo-aware), capped. */
function packageJsons(root: string, files: string[]): Array<{ rel: string; json: Record<string, unknown> }> {
  const out: Array<{ rel: string; json: Record<string, unknown> }> = [];
  for (const rel of files) {
    if (out.length >= 8) break;
    if (rel !== "package.json" && !/^[^/]+\/package\.json$/.test(rel)) continue;
    const json = parseJson(readMaybe(root, rel));
    if (json) out.push({ rel, json });
  }
  return out;
}

function depNames(pkgs: Array<{ json: Record<string, unknown> }>): Set<string> {
  const names = new Set<string>();
  for (const { json } of pkgs) {
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = json[field];
      if (deps && typeof deps === "object") for (const k of Object.keys(deps)) names.add(k);
    }
  }
  return names;
}

function detectLanguages(files: string[]): string[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const lang = languageOf(f);
    if (!lang || NON_CODE_LANGS.has(lang)) continue;
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([lang]) => lang);
}

function detectPackageManagers(root: string, files: string[]): string[] {
  const found = new Set<string>();
  const basenames = new Set(files.map((f) => f.split("/").pop() ?? f));
  for (const [file, pm] of Object.entries(LOCKFILES)) if (basenames.has(file)) found.add(pm);
  for (const [file, pm] of Object.entries(MANIFESTS)) {
    if (basenames.has(file) && existsSync(join(root, file))) found.add(pm);
  }
  return [...found].sort();
}

function detectFrameworks(root: string, files: string[], deps: Set<string>): string[] {
  const found = new Set<string>();
  for (const [re, label] of JS_FRAMEWORKS) for (const d of deps) if (re.test(d)) found.add(label);
  const py = (readMaybe(root, "requirements.txt") ?? "") + (readMaybe(root, "pyproject.toml") ?? "");
  for (const [re, label] of PY_FRAMEWORKS) if (re.test(py)) found.add(label);
  if (files.some((f) => f === "go.mod")) {
    const gomod = readMaybe(root, "go.mod") ?? "";
    if (/gin-gonic|gofiber|echo|chi/i.test(gomod)) found.add("go-web");
  }
  return [...found].sort();
}

function detectCi(root: string): string[] {
  const found = new Set<string>();
  for (const [path, label] of CI_SIGNALS) {
    const full = join(root, path);
    if (existsSync(full)) {
      if (label === "github-actions") {
        // require at least one workflow file
        try {
          if (readdirSync(full).some((f) => /\.ya?ml$/.test(f))) found.add(label);
        } catch {
          /* ignore */
        }
      } else {
        found.add(label);
      }
    }
  }
  return [...found].sort();
}

function detectTest(
  root: string,
  files: string[],
  pkgs: Array<{ json: Record<string, unknown> }>,
  deps: Set<string>,
): { framework?: string; command?: string } {
  // JS: a test runner in deps + a `test` script.
  for (const [re, fw] of JS_TEST_RUNNERS) {
    if ([...deps].some((d) => re.test(d))) {
      const scripts = pkgs.map((p) => p.json.scripts).find((s) => s && typeof s === "object") as
        | Record<string, string>
        | undefined;
      const command = scripts?.test ? "npm test" : `npx ${fw} run`;
      return { framework: fw, command };
    }
  }
  // Python.
  if (files.some((f) => /(^|\/)conftest\.py$/.test(f) || /_test\.py$|test_.*\.py$/.test(f))) {
    return { framework: "pytest", command: "pytest" };
  }
  // Go.
  if (files.some((f) => /_test\.go$/.test(f))) return { framework: "go-test", command: "go test ./..." };
  // Rust.
  if (existsSync(join(root, "Cargo.toml"))) return { framework: "cargo-test", command: "cargo test" };
  return {};
}

const ENTRY_CANDIDATES = [
  "src/index.ts", "src/index.tsx", "src/index.js", "src/main.ts", "src/main.tsx", "src/main.js",
  "index.ts", "index.js", "main.ts", "main.js", "main.py", "app.py", "manage.py", "main.go", "server.ts", "server.js",
];

function detectEntrypoints(root: string, files: string[], pkgs: Array<{ rel: string; json: Record<string, unknown> }>): string[] {
  const found = new Set<string>();
  for (const c of ENTRY_CANDIDATES) if (files.includes(c)) found.add(c);
  // Monorepo: <module>/src/index.* and <module>/main.go etc.
  for (const f of files) {
    if (/^[^/]+\/(src\/)?(index|main|server)\.(ts|tsx|js|go|py)$/.test(f)) found.add(f);
    if (/^cmd\/[^/]+\/main\.go$/.test(f)) found.add(f);
    if (/^src\/apps\/[^/]+\/main\.ts$/.test(f)) found.add(f);
  }
  // package.json bin / main.
  for (const { rel, json } of pkgs) {
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
    const main = json.main;
    if (typeof main === "string") found.add((dir + main).replace(/^\.\//, ""));
    const bin = json.bin;
    if (typeof bin === "string") found.add((dir + bin).replace(/^\.\//, ""));
    else if (bin && typeof bin === "object") {
      for (const v of Object.values(bin)) if (typeof v === "string") found.add((dir + v).replace(/^\.\//, ""));
    }
  }
  return [...found].filter((f) => existsSync(join(root, f))).sort().slice(0, 12);
}

function riskOf(name: string): RiskLevel {
  if (HIGH_RISK.test(name)) return "high";
  if (LOW_RISK.test(name)) return "low";
  return "medium";
}

function detectModules(root: string, files: string[]): Module[] {
  const topDirs = new Set<string>();
  for (const f of files) {
    const slash = f.indexOf("/");
    if (slash > 0) topDirs.add(f.slice(0, slash));
  }
  const codeByDir = new Map<string, number>();
  for (const f of files) {
    const slash = f.indexOf("/");
    if (slash <= 0) continue;
    const dir = f.slice(0, slash);
    if (languageOf(f)) codeByDir.set(dir, (codeByDir.get(dir) ?? 0) + 1);
  }
  return [...topDirs]
    .filter((d) => !d.startsWith(".") && (codeByDir.get(d) ?? 0) > 0)
    .sort()
    .slice(0, 24)
    .map((name) => ({ name, path: name, risk: riskOf(name) }));
}

/**
 * Deterministic, model-free repo inventory: languages, package managers, frameworks,
 * CI, test framework + command, entrypoints, and top-level module boundaries.
 */
export function buildInventory(repoDir: string): Inventory {
  const files = walkFiles(repoDir);
  const pkgs = packageJsons(repoDir, files);
  const deps = depNames(pkgs);

  return Inventory.parse({
    languages: detectLanguages(files),
    frameworks: detectFrameworks(repoDir, files, deps),
    packageManagers: detectPackageManagers(repoDir, files),
    ci: detectCi(repoDir),
    test: detectTest(repoDir, files, pkgs, deps),
    entrypoints: detectEntrypoints(repoDir, files, pkgs),
    modules: detectModules(repoDir, files),
  });
}
