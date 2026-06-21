# previewer

**An autonomous, context-aware AI pull-request reviewer you run on your own machine.**

It watches your GitHub pull requests and, the moment a PR is opened or updated, posts **one
plain top-level review comment** — tuned to *that* repo's architecture, invariants, and security
rules. It runs on your **Claude subscription** via the `claude` CLI (no paid API key), reviews
**multiple repos**, never double-posts, and always applies a security/privacy/risk lens.

> Status: working MVP. Milestones M0–M8 done (incl. event-driven webhooks and automatic repo
> onboarding). Proven live on a real PR and on real repo onboarding. 72 tests, type-checked.
> Not yet done: cost tuning (M9).

---

## Table of contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start (5 minutes)](#quick-start-5-minutes)
- [Core concepts](#core-concepts)
- [Onboard a repo](#onboard-a-repo)
- [Usage](#usage)
  - [Review a PR (CLI)](#1-review-a-pr-cli)
  - [Catch up on all open PRs (reconciler)](#2-catch-up-on-all-open-prs-reconciler)
  - [Go fully autonomous (webhooks)](#3-go-fully-autonomous-webhooks)
- [Configuration reference](#configuration-reference)
- [Auth & secrets](#auth--secrets)
- [Project structure](#project-structure)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)

---

## What it does

A normal "AI review" tool comments on the diff. This one is built to **catch real regressions** —
broken cross-file contracts, privacy leaks, weakened auth, data-provenance bugs — not style nits.
It does that by giving the model a **per-repo context pack** (architecture guide, module boundaries,
hard invariants, routing rules, a mandatory security baseline) and letting it read the actual code.

Key properties:

- **Event-driven** — reacts to PR events (webhook) the moment they happen; a periodic *reconciler*
  guarantees nothing is missed even if your machine was off.
- **Context-aware** — each repo has a context pack; only the relevant slice is sent per PR.
- **Security baseline always** — every review checks data leaks, authz, SSRF/exfiltration, auth/session
  regressions, secret exposure, regardless of the change.
- **Exactly one comment per head SHA** — never a formal GitHub review; re-runs update in place; new
  commits get a fresh review. No spam.
- **On your subscription** — the default runner is `claude -p` (Claude Code) authenticated with your
  Pro/Max subscription. No per-token API bill.
- **Pluggable model backend** — `claude -p` by default; an API runner is swappable behind one contract.
- **Multi-repo** — add repos as config directories.

---

## How it works

```
 PR event ──webhook──▶ Ingress ─┐                Reconciler ──poll (cheap)──▶ GitHub
 (opened/sync/…)     (verify·    │                (sweep open PRs,
                      filter)    ▼                 catch what webhook missed)
                          ┌──────────────┐                 │
                          │ Durable queue│◀──── enqueue ───┘
                          │  (SQLite)    │
                          └──────┬───────┘
                                 │ lease
                                 ▼
   Context pack ──resolve──▶  Worker  ──▶  Runner (claude -p)  ──▶  one PR comment
   (per repo)               gate → diff → review → publish → record (dedupe + audit)
```

- **Webhook** is the fast path (review within seconds). **Reconciler** is the completeness guarantee
  (it re-scans open PRs on a schedule and reviews any head SHA that has no successful review yet).
- Everything is **idempotent**: webhook delivery IDs, the durable job queue, the per-`(repo, pr, head_sha)`
  review claim, and the comment marker all prevent duplicates.

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Build log: [`docs/MILESTONES.md`](docs/MILESTONES.md).

---

## Requirements

- **Node.js ≥ 20** (developed on 22) and **git**.
- **At least one agentic CLI on your subscription:**
  - **Claude Code CLI** (`claude`) — the default. Run `claude` once and `/login`, or create a headless
    token (see [Auth](#auth--secrets)). Verify: `claude --version`.
  - **OpenAI Codex CLI** (`codex`) — optional alternative. `codex login` (ChatGPT subscription).
    Verify: `codex --version`. Select it per-run with `--runner codex-cli` or per-repo in `repo.yaml`.
- For posting comments / reading PRs from GitHub: a **GitHub token**. The easy path is the GitHub CLI
  (`gh auth login`) — then `gh auth token` prints a usable token. (A dedicated GitHub App is the clean
  multi-repo option later.)
- macOS or Linux. (Windows via WSL.)

> You can do a **fully offline dry-run** with only `claude` + a local git checkout — no GitHub token,
> nothing posted. That's the recommended first run.

---

## Install

```bash
git clone <this-repo> previewer && cd previewer
npm install
npm test        # 64 tests, ~1s — confirms everything builds and works
npm run cli -- help
```

---

## Quick start (5 minutes)

The fastest way to *see a real review* with zero risk: a **dry-run** against a local checkout of any
repo you have. It reads the diff + your code, prints the review to the console, and posts nothing.

```bash
# 1. Make sure `claude` is authed to your subscription:
echo 'Reply {"ok":true} as JSON' | claude -p --output-format json --max-turns 1
#    -> should return  is_error:false  (if it says "Not logged in", run `claude` then /login)

# 2. Onboard the repo you want to review (one-time, see "Onboard a repo" below).

# 3. Dry-run review of a branch vs its base, fully offline:
npm run cli -- review <owner>/<repo> 1 --dry-run \
  --local /path/to/your/checkout \
  --head <feature-branch-or-sha> \
  --base <main-or-base-branch>
```

You'll see a full Markdown review with severity-ordered findings printed to your terminal. When you're
happy, drop `--dry-run` and add a token to post it for real (see [Usage](#usage)).

---

## Core concepts

**Context pack** — a per-repo bundle the reviewer uses. Lives in
`config/repos/<owner>__<name>/context-pack/`:

| File | What it is |
|---|---|
| `repo-guide.md` | repo overview: stack, module boundaries, conventions |
| `subsystems/*.md` | per-area guides (one markdown file per subsystem) |
| `routing.yaml` | which **review profiles** activate for which changed paths |
| `profiles.yaml` | review profiles: focus areas + which docs/tests to load |
| `invariants.yaml` | hard rules that must hold (with severity + reviewer questions) |
| `security-baseline.yaml` | the mandatory security/privacy lens (applied to every PR) |
| `comment-template.md` | the shape of the posted comment |
| `manifest.yaml` | version + provenance of the pack |

**Additive routing** — a PR activates the **union** of profiles from every matched route, plus the
mandatory `security-baseline`. Only that slice of the pack is sent to the model (cost control).

**Runner** — the model backend behind one contract. Two agentic CLI runners ship, both on your
subscription (they read files, can run tests): `claude-cli` (`claude -p`, default) and `codex-cli`
(`codex exec`, OpenAI Codex). They share the *same* review prompt + output contract — only the engine
differs. Pick per-run with `--runner <id>` or per-repo via `runner.default` in `repo.yaml`. An Anthropic
API runner is also available as an option. The same applies to onboarding: `onboard … --runner codex-cli`.

**Dedupe** — reviews are keyed by `(repo, pr_number, head_sha)`. A successful review of a SHA is never
repeated; a new push (new SHA) gets a fresh review. Use `--force` to re-review.

**Reconciler vs webhook** — webhook = instant reaction; reconciler = periodic safety net. You can run
either or both; running both is the robust setup.

---

## Onboard a repo

The fastest way is **automatic onboarding** — point it at a checkout and it builds the pack for you:

```bash
# Offline, from a local checkout (no GitHub token needed):
npm run cli -- onboard <owner>/<name> --local /path/to/checkout

# Preview without writing anything:
npm run cli -- onboard <owner>/<name> --local /path/to/checkout --dry-run
```

What it does, in stages: **inventory** (languages, frameworks, CI, test command, modules — all
deterministic, no model) → **discover** existing context (`README`, `CLAUDE.md`, the `AGENTS.md`
hierarchy, `docs/`) → **assess + decide** per artifact whether to *ingest* what's there or *generate*
it → **generate** the missing/weak pieces with `claude -p` (reading the repo) → **persist** the pack +
`repo.yaml` with per-artifact provenance. Existing guides are ingested verbatim (cheap); only the
structured pieces (routing, profiles, invariants) are generated.

**Generated invariants are never auto-enforced.** They land as `needs_confirmation` and are listed
under "Needs confirmation" in the output. Review them, then approve in one go:

```bash
npm run cli -- onboard <owner>/<name> --local /path/to/checkout --confirm-invariants
```

Re-running is safe: it bumps the pack `version` and preserves already-confirmed invariants. Flags:
`--threshold <0..1>` (use-existing score, default 0.7), `--model <id>`, `--dry-run`. Without `--local`
it clones the default branch (set `GITHUB_TOKEN` for private repos).

### Manual alternative

You can also write the pack by hand — a complete worked example ships in
[`config/repos/_example/`](config/repos/_example).

1. Create the directory (`/` in the repo id becomes `__`):

   ```bash
   mkdir -p config/repos/<owner>__<name>/context-pack/subsystems
   ```

2. Create `config/repos/<owner>__<name>/repo.yaml`:

   ```yaml
   repo:
     id: <owner>/<name>
     enabled: true
     defaultBranch: main
   events:
     triggers: [opened, reopened, synchronize, ready_for_review]
     ignoreDraft: true
     ignorePaths: ["**/*.lock", "**/dist/**", "**/node_modules/**"]
   review:
     defaultProfile: security-baseline
     incremental: true
     maxTokensPerRun: 120000
   runner:
     default: claude-cli        # `claude -p` on your subscription
   publish:
     mode: single_top_level_comment
     formalReview: false
   context:
     source: hybrid
     packRef: context-pack@v1
   ```

3. Create the **5 required** pack files (the rest are optional). Minimal versions:

   `context-pack/manifest.yaml`
   ```yaml
   version: 1
   generatedAt: "2026-01-01T00:00:00Z"
   ```
   `context-pack/security-baseline.yaml`
   ```yaml
   alwaysCheck: [data_leaks, unauthorized_access, dangerous_external_calls,
     auth_session_regressions, privacy_boundary_leaks, insecure_reads_writes,
     analytics_data_exfiltration, supply_chain_secret_exposure]
   severityFloor: medium
   ```
   `context-pack/profiles.yaml`
   ```yaml
   profiles:
     security-baseline:
       depth: normal
       focus: [correctness, data_leak, authz, session]
       docs: []
       tests: []
   ```
   `context-pack/routing.yaml`
   ```yaml
   version: 1
   defaults:
     mandatoryProfiles: [security-baseline]
     requiredContext: [README.md]
   routes: []
   ```
   `context-pack/invariants.yaml`
   ```yaml
   invariants: []
   ```

4. (Recommended) add `context-pack/repo-guide.md` (a paragraph on the stack + module boundaries),
   `context-pack/comment-template.md`, and `routes`/`profiles` for your hot areas. Copy patterns from
   [`config/repos/_example/`](config/repos/_example) — it shows real routing, profiles, and invariants.

Validate it loaded:

```bash
npm run cli -- review <owner>/<name> 1 --dry-run --local /path/to/checkout --head HEAD --base main
```

---

## Usage

### 1. Review a PR (CLI)

```bash
# Offline dry-run (only needs claude + a local checkout):
npm run cli -- review <owner>/<repo> <pr#> --dry-run \
  --local /path/to/checkout --head <sha-or-ref> --base <sha-or-ref>

# Review a real GitHub PR and POST the comment (needs a GitHub token):
GITHUB_TOKEN=$(gh auth token) npm run cli -- review <owner>/<repo> <pr#>

# Re-review a SHA that was already reviewed (or unblock an interrupted run):
... --force
```

Flags: `--dry-run` (print, don't post) · `--local <path>` (use a local checkout, non-destructive git
worktree) · `--head <sha|ref>` `--base <sha|ref>` (offline, skip the GitHub API) · `--force` (ignore
dedupe) · `--token <pat>` (prefer the `GITHUB_TOKEN` env instead — see [Auth](#auth--secrets)).

### 2. Catch up on all open PRs (reconciler)

```bash
# See what would be reviewed (metadata only, $0):
GITHUB_TOKEN=$(gh auth token) npm run cli -- reconcile-now --dry-run

# Actually review every open PR that has no review yet:
GITHUB_TOKEN=$(gh auth token) npm run cli -- reconcile-now

# Run it forever on a schedule (on start + every N hours from platform config):
GITHUB_TOKEN=$(gh auth token) npm run reconciler
```

### 3. Go fully autonomous (webhooks)

React to PR events instantly. Full guide: [`docs/EVENT-DRIVEN.md`](docs/EVENT-DRIVEN.md). In short:

```bash
export GITHUB_TOKEN=$(gh auth token)
export GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)   # remember this value
npm run ingress                                        # listens on :8787

# in another shell — expose it publicly:
cloudflared tunnel --url http://localhost:8787         # prints an https URL
```

Then in GitHub → repo → Settings → Webhooks → Add: Payload URL `https://<tunnel>/webhook`, content
type `application/json`, the same secret, events = **Pull requests**. Open or push a PR → a review
comment appears within seconds. The ingress process also runs a catch-up sweep on start.

### Audit token usage & cost

Every review records the runner, model, status, tokens, and cost. Inspect the history (read-only, no
token needed):

```bash
npm run cli -- inspect                      # rollup per repo: runs, ok/err/skip, tokens, $
npm run cli -- inspect <owner>/<repo>       # the last runs for one repo (--limit N)
```

---

## Configuration reference

**`config/platform.yaml`** (copy from `config/platform.example.yaml`) — global settings: `dbPath`,
`workspacesDir`, `reposDir`, `defaultLanguage` (`en`/`ru`), `logLevel`, and `reconciler.everyHours`.

**`config/repos/<owner>__<name>/repo.yaml`** — per-repo: which events trigger, `ignorePaths`, review
depth, `runner.default` + cost/risk `overrides`, publish mode, and the context source. See
[`config/repos/_example/repo.yaml`](config/repos/_example/repo.yaml).

**`config/repos/<owner>__<name>/context-pack/`** — the pack (see [Onboard a repo](#onboard-a-repo)).

All formats are defined as zod schemas in [`src/config/schema/`](src/config/schema) — the single source
of truth. YAML keys are camelCase to match the schemas.

---

## Auth & secrets

Two credentials, handled separately:

1. **Claude (the reviewer).** `claude` must be logged into your **subscription** as a standalone CLI —
   not borrowed from a running Claude Code session. Either:
   - run `claude` interactively → `/login` (stores credentials), or
   - `claude setup-token` → export the printed token as `CLAUDE_CODE_OAUTH_TOKEN` (best for a headless
     agent machine / service).

   The runner spawns `claude` with a **sanitized environment** (it strips `ANTHROPIC_BASE_URL`,
   `CLAUDE_CODE_*`, etc., but keeps `CLAUDE_CODE_OAUTH_TOKEN`) so it always authenticates against your
   subscription rather than an inherited proxied session.

2. **GitHub (read PRs + post).** Provide a token via the **`GITHUB_TOKEN` environment variable**
   (e.g. `GITHUB_TOKEN=$(gh auth token)`).

> ⚠️ **Don't pass the token with `--token "$(gh auth token)"`** — `npm run` echoes the expanded command
> and your token ends up in the terminal/logs. Use the `GITHUB_TOKEN` env var instead. If a token ever
> leaks, revoke it (GitHub → Settings → Applications → revoke, then `gh auth login`).

Secrets live in env / your service config, never in the repo. `data/`, `.env`, and `secrets/` are
gitignored.

---

## Project structure

```
src/
  config/        zod schemas for every format + a loader  (the contract layer)
  core/          behavioral interfaces (Store, Queue, Runner, Publisher, ContextProvider, GitHubClient)
  store/         SQLite Store + Queue (dedupe, leases, retry/dead-letter)
  github/        App/PAT auth, HMAC webhook verify, checkout/diff/worktree, idempotent publish
  context/       context-pack load + additive routing
  runners/       runner registry + `claude -p` CLI runner (+ API runner stub)
  apps/
    cli/         the `review` / `reconcile-now` / `onboard` commands
    worker/      the review pipeline (gate → context → diff → runner → publish → record)
    reconciler/  the completeness sweep + scheduler
    ingress/     the webhook HTTP server
  compose.ts     composition root (wires everything from config + env)
config/
  platform.example.yaml
  repos/<owner>__<name>/   repo.yaml + context-pack/
data/            SQLite db + cloned workspaces (gitignored, created at runtime)
docs/            ARCHITECTURE.md · MILESTONES.md · EVENT-DRIVEN.md
tests/           64 tests across 10 files
```

Run targets: `npm run cli` · `npm run worker` · `npm run reconciler` · `npm run ingress`.

---

## Development

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm run test:watch    # watch mode
```

Stack: TypeScript (strict), Node 22, `zod` (schemas), `better-sqlite3` (state), `@octokit/rest` +
`@octokit/auth-app` (GitHub), `yaml`, `vitest`, `tsx`. No build step for running — `tsx` executes the
TypeScript directly.

Tests are deterministic and offline: SQLite runs in `:memory:`, git is exercised against temp repos, the
`claude` CLI and Octokit are mocked behind injectable seams. So `npm test` needs no credentials.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `claude error: ... 401 Invalid authentication credentials` | `claude` isn't authed to your subscription in this shell (often you're inside a Claude Code session whose proxied auth a child can't reuse). Run from a plain terminal; do `claude /login` or set `CLAUDE_CODE_OAUTH_TOKEN`. Verify with the snippet in [Quick start](#quick-start-5-minutes). |
| `Not logged in · Please run /login` | Same — no standalone Claude login on this machine. `claude` → `/login`, or `claude setup-token`. |
| `Already reviewed this head SHA (dedupe)` but nothing posted | A previous run was interrupted (Ctrl-C) and left a claim. Re-run with `--force`. (Failed/stale claims also auto-heal after ~15 min.) |
| Empty review / `claude error [error_max_turns]` | The agentic read hit the turn cap. `--max-turns` defaults to 40; very large PRs may need more (size-aware tuning is M9). |
| `GitHub access needed: set GITHUB_TOKEN` | Set `GITHUB_TOKEN=$(gh auth token)` (needed for posting and for `reconcile-now`/`ingress`). |
| "Tests were not run" in the review | Worktrees have no `node_modules`, so the reviewer reviews from code + diff and says so honestly. Installing deps in the worktree is M9. |
| Tunnel URL changes on restart | `cloudflared tunnel --url` gives a random URL. Use a **named tunnel** for a stable host. |

---

## Roadmap

Done: **M0** contracts · **M1** store/queue · **M2** GitHub gateway · **M3** context plane · **M4** runner ·
**M5** worker+CLI · **M6** webhook ingress · **M7** reconciler · **M8** automatic onboarding
(`onboard <repo>` builds a pack) · **second runner** (`codex-cli` — review + onboarding via OpenAI Codex,
alongside `claude-cli`). Next: **M9** cost tuning (size-aware turns, run tests in the worktree, cost caps,
tighter routing, auto runner-selection by size/risk), and a GitHub App identity. See [`docs/MILESTONES.md`](docs/MILESTONES.md).

---

<sub>Default model backend is the Claude Code CLI on your subscription. Built milestone-by-milestone;
the design rationale lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).</sub>
