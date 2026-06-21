# Event-driven setup (webhook via Cloudflare Tunnel)

The reviewer reacts to PR events the moment they happen: GitHub → Cloudflare Tunnel →
local ingress server → queue → review → comment. The reconciler keeps running as a
backstop for anything missed while the machine/tunnel was down.

## 1. Run the ingress server (agent machine)

```bash
export GITHUB_TOKEN=$(gh auth token)            # list PRs + post comments
export GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)   # pick a secret, keep it
# claude must be logged into your subscription (claude /login or CLAUDE_CODE_OAUTH_TOKEN)
npm run ingress                                  # listens on :8787, POST any path
```

On start it runs one reconcile sweep (catch-up), then serves live webhooks. It both
receives and processes in one process.

## 2. Expose it with a tunnel

```bash
brew install cloudflared
# quick (random URL):
cloudflared tunnel --url http://localhost:8787
# -> prints https://<random>.trycloudflare.com  (use as the webhook URL)
```

For a stable URL, create a named tunnel (`cloudflared tunnel create previewer`) bound to
a hostname you own; see Cloudflare Tunnel docs. Run it as a service so it survives reboots.

## 3. Configure the GitHub webhook

Repo (or org) → Settings → Webhooks → Add webhook:

- **Payload URL:** `https://<your-tunnel-host>/webhook`
- **Content type:** `application/json`
- **Secret:** the same `GITHUB_WEBHOOK_SECRET`
- **Events:** "Let me select individual events" → **Pull requests** only
- Active: ✓

The first delivery is a `ping` → the server replies `pong` (200). Open/sync a PR and a
review comment appears within seconds.

For multiple repos, the clean option is a **GitHub App** (one webhook for all installed
repos, least-privilege, posts as a bot). A per-repo/org webhook + your PAT is the quick start.

## 4. Keep it alive (optional but recommended)

Run `npm run ingress` and the tunnel under a process manager so they restart on reboot
(macOS `launchd`, `pm2`, or `tmux`). Put `GITHUB_TOKEN` / `GITHUB_WEBHOOK_SECRET` /
`CLAUDE_CODE_OAUTH_TOKEN` in the service environment — never on the command line (npm echoes it).

## What runs where

| Piece | Where | Role |
|---|---|---|
| GitHub webhook | github.com | fires on PR events |
| Cloudflare Tunnel | agent machine | public URL → localhost |
| `npm run ingress` | agent machine | verify → enqueue → review → comment |
| reconciler (built-in on start + `npm run reconciler`) | agent machine | completeness backstop |
