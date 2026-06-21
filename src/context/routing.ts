import type { ContextPack, ResolvedContext, ReviewProfile, ChangedFile } from "../config";

/** Minimal glob matcher: `**` (any path incl. `/`), `*` (any non-`/`), literals. */
export function globMatch(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // `**/` => zero or more dirs
        } else {
          re += ".*"; // `**` => anything
        }
      } else {
        re += "[^/]*"; // `*` => anything but `/`
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * Additive resolution: the active profile set is `defaults.mandatoryProfiles` plus
 * the union of `activateProfiles` from every route whose globs match a changed file.
 * Subsystems are selected by path-prefix, invariants by `appliesTo`, security baseline
 * is always included. The pack is never returned whole — only this narrowed slice.
 */
export function resolveContext(pack: ContextPack, changed: ChangedFile[]): ResolvedContext {
  const paths = changed.map((c) => c.path);
  const matchesAny = (glob: string): boolean => paths.some((p) => globMatch(glob, p));

  const active = new Set<string>(pack.routing.defaults.mandatoryProfiles);
  for (const route of pack.routing.routes) {
    if (route.paths.some(matchesAny)) {
      for (const name of route.activateProfiles) active.add(name);
    }
  }
  const activeProfiles = [...active];

  const profiles: ReviewProfile[] = [];
  const docs = new Set<string>(pack.routing.defaults.requiredContext);
  const tests = new Set<string>();
  for (const name of activeProfiles) {
    const prof = pack.profiles.profiles[name];
    if (!prof) continue;
    profiles.push(prof);
    for (const d of prof.docs) docs.add(d);
    for (const t of prof.tests) tests.add(t);
  }

  const subsystems = pack.subsystems.filter((s) =>
    paths.some((p) => p === s.path || p.startsWith(s.path + "/")),
  );
  const invariants = pack.invariants.invariants.filter((inv) => inv.appliesTo.some(matchesAny));

  return {
    packVersion: `context-pack@v${pack.manifest.version}`,
    repoGuideExcerpt: pack.repoGuide,
    subsystems,
    invariants,
    securityBaseline: pack.securityBaseline,
    commentTemplate: pack.commentTemplate,
    activeProfiles,
    profiles,
    tests: [...tests],
    requiredDocs: [...docs],
    riskMap: pack.riskMap.entries,
  };
}
