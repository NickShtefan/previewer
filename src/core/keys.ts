import type { ReviewKey } from "../config";

export function reviewKey(repo: string, prNumber: number, headSha: string): ReviewKey {
  return { repo, prNumber, headSha };
}

export function reviewKeyString(k: ReviewKey): string {
  return `${k.repo}#${k.prNumber}@${k.headSha.slice(0, 12)}`;
}

/** Expand a publish-marker template into a concrete hidden HTML comment. */
export function commentMarker(template: string, repo: string, pr: number, headSha: string): string {
  return template
    .replaceAll("{repo}", repo)
    .replaceAll("{pr}", String(pr))
    .replaceAll("{head_sha}", headSha);
}
