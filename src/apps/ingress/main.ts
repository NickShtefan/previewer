/* Webhook ingress — receives GitHub PR events, enqueues, and processes them.
   Point a tunnel (e.g. cloudflared) at this server. See docs/EVENT-DRIVEN.md. */
import { createServer } from "node:http";
import { composePlatform } from "../../compose";
import { redactSecrets } from "../../core";
import { GithubWebhookVerifier } from "../../github";
import { drainQueue } from "../worker/loop";
import { reconcile } from "../reconciler/reconcile";
import { handleWebhook } from "./server";

/** Cap on the wake-up delay so a far-future (or overflowed) value can't disable setTimeout;
 *  an early fire just drains (a no-op if nothing is due yet) and reschedules. */
const MAX_WAKE_MS = 30 * 60_000;

async function main(): Promise<void> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error("GITHUB_WEBHOOK_SECRET is required for the ingress server.");
    process.exitCode = 1;
    return;
  }
  const p = composePlatform();
  const verifier = new GithubWebhookVerifier(secret);
  const port = Number(process.env.PORT ?? 8787);

  // Single-process processor: drain the queue, coalescing concurrent webhook kicks
  // so jobs arriving mid-drain are still picked up (no lost wakeups).
  let draining = false;
  let pending = false;

  // A backed-off transient retry (nackTransient) sets a FUTURE visible_at. Without a timer
  // the job would only be re-drained on the next webhook or the hourly reconciler sweep, so a
  // retry scheduled 60s out could sleep for an hour. Schedule a single self-rescheduling wake-up
  // at the earliest pending visible_at so the retry fires on time.
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleWake = async (): Promise<void> => {
    let next: Date | null;
    try {
      next = await p.queue.nextVisibleAt();
    } catch (e) {
      p.logger.error(redactSecrets(`wake schedule failed: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    if (!next) return;
    const delay = Math.min(Math.max(0, next.getTime() - Date.now()), MAX_WAKE_MS);
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      kick();
    }, delay);
    wakeTimer.unref?.();
  };

  const kick = (): void => {
    pending = true;
    if (draining) return;
    draining = true;
    void (async () => {
      try {
        while (pending) {
          pending = false;
          await drainQueue(p.queue, (repo) => p.pipelineDepsFor(repo), { logger: p.logger });
        }
      } catch (e) {
        p.logger.error(redactSecrets(`drain failed: ${e instanceof Error ? e.message : String(e)}`));
      } finally {
        draining = false;
        // Re-arm the wake-up for whatever is still backed off after this drain settled.
        void scheduleWake();
      }
    })();
  };

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    let body = "";
    let tooBig = false;
    req.on("data", (c) => {
      body += c;
      if (body.length > 5_000_000) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return;
      void handleWebhook(
        { verifier, store: p.store, queue: p.queue, github: p.github, repoConfigs: p.repoConfigs, logger: p.logger },
        {
          event: String(req.headers["x-github-event"] ?? ""),
          deliveryId: String(req.headers["x-github-delivery"] ?? ""),
          signature: String(req.headers["x-hub-signature-256"] ?? ""),
          rawBody: body,
        },
      )
        .then((o) => {
          res.writeHead(o.status, { "content-type": "text/plain" }).end(o.message);
          if (o.kind === "enqueued") p.logger.info(`webhook: ${o.message}`);
          if (o.enqueued) kick();
        })
        .catch((e) => {
          res.writeHead(500).end("error");
          p.logger.error(redactSecrets(`webhook handler failed: ${e instanceof Error ? e.message : String(e)}`));
        });
    });
  });

  server.listen(port, () => {
    p.logger.info(`ingress listening on http://localhost:${port} (POST any path). Point a tunnel here.`);
  });

  // Catch up on anything missed while down; live webhooks handle everything after.
  reconcile(p, {})
    .then((r) => {
      p.logger.info(`startup reconcile: scanned ${r.scanned}, enqueued ${r.enqueued}, processed ${r.processed}`);
      // A transient failure during the catch-up drain may have backed a job off — arm the waker.
      void scheduleWake();
    })
    .catch((e) => p.logger.error(redactSecrets(`startup reconcile failed: ${e instanceof Error ? e.message : String(e)}`)));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
