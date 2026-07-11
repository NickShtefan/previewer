/* The entire dashboard UI: one self-contained HTML document (inline CSS + vanilla
   JS, no build step, no framework). It polls GET /api/status every 2s and renders
   the shape produced by buildStatus() in queries.ts. */

export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>previewer · dashboard</title>
<style>
  :root {
    --bg: #0b0f14;
    --panel: #131a23;
    --panel-2: #0f151d;
    --border: #223042;
    --text: #e6edf3;
    --muted: #8b98a9;
    --dim: #5c6b7d;
    --accent: #4aa8ff;
    --ok: #3fb950;
    --warn: #d29922;
    --err: #f85149;
    --live: #2ea043;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: var(--sans); font-size: 15px; line-height: 1.45;
    padding: 20px 20px 60px;
  }
  a { color: var(--accent); text-decoration: none; }
  header {
    display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
    border-bottom: 1px solid var(--border); padding-bottom: 14px; margin-bottom: 22px;
  }
  header h1 { margin: 0; font-size: 24px; letter-spacing: .5px; }
  header h1 .dim { color: var(--dim); font-weight: 400; }
  .status-line { color: var(--muted); font-size: 13px; margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); display: inline-block; }
  .dot.on { background: var(--live); box-shadow: 0 0 8px var(--live); }
  .dot.off { background: var(--err); }
  section { margin-bottom: 30px; }
  section > h2 {
    font-size: 13px; text-transform: uppercase; letter-spacing: 1.4px;
    color: var(--muted); margin: 0 0 12px; font-weight: 600;
  }
  .mono { font-family: var(--mono); }
  .sha { font-family: var(--mono); color: var(--dim); }

  /* System / Health */
  .sys-cards { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
  .sys-card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .sys-card h3 {
    margin: 0 0 12px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--muted); font-weight: 600;
  }
  .sys-engine .big { font-size: 22px; font-weight: 700; font-family: var(--mono); line-height: 1.1; word-break: break-word; }
  .sys-engine .sub { color: var(--muted); font-size: 13px; font-family: var(--mono); margin-top: 4px; }
  .sys-engine .repo { color: var(--dim); font-size: 12px; margin-top: 8px; }
  .kv { display: flex; align-items: center; gap: 8px; font-size: 14px; padding: 4px 0; }
  .kv .k { color: var(--muted); min-width: 62px; }
  .kv .v { font-family: var(--mono); }
  .chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 20px; font-size: 12px; font-weight: 600; font-family: var(--mono); }
  .chip.ok { background: rgba(63,185,80,.15); color: var(--ok); }
  .chip.bad { background: rgba(248,81,73,.15); color: var(--err); }
  .chip.warn { background: rgba(210,153,34,.18); color: var(--warn); }
  .chip.muted { background: rgba(139,152,169,.12); color: var(--muted); }
  .repo-list { display: grid; gap: 8px; }
  .repo-row { display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap; }
  .repo-row .name { font-weight: 600; }
  .repo-row .eng { color: var(--dim); font-family: var(--mono); font-size: 12px; }

  /* Reviewing now */
  .reviewers { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
  .rev-card {
    background: linear-gradient(180deg, var(--panel), var(--panel-2));
    border: 1px solid var(--border); border-left: 3px solid var(--live);
    border-radius: 10px; padding: 16px 18px;
  }
  .rev-card.stale { border-left-color: var(--warn); }
  .rev-engine { font-size: 20px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
  .rev-engine .pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--live); animation: pulse 1.4s infinite; }
  .rev-card.stale .pulse { background: var(--warn); animation: none; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  .rev-model { color: var(--muted); font-size: 14px; margin: 2px 0 12px; font-family: var(--mono); }
  .rev-target { font-size: 15px; }
  .rev-meta { color: var(--dim); font-size: 13px; margin-top: 8px; display: flex; gap: 14px; flex-wrap: wrap; }
  .idle { color: var(--dim); background: var(--panel-2); border: 1px dashed var(--border); border-radius: 10px; padding: 22px; text-align: center; font-size: 16px; }

  /* Queue tiles */
  .tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
  .tile { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .tile .n { font-size: 30px; font-weight: 700; font-family: var(--mono); line-height: 1; }
  .tile .l { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .8px; margin-top: 6px; }
  .tile.warn .n { color: var(--warn); }
  .tile.err .n { color: var(--err); }
  .tile.live .n { color: var(--live); }

  /* Tables */
  .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  thead th {
    text-align: left; color: var(--muted); font-weight: 600; font-size: 11px;
    text-transform: uppercase; letter-spacing: .8px; padding: 10px 14px;
    background: var(--panel-2); border-bottom: 1px solid var(--border); white-space: nowrap;
  }
  tbody td { padding: 11px 14px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: rgba(255,255,255,.02); }
  .num { text-align: right; font-family: var(--mono); }

  .badge { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 12px; font-weight: 600; font-family: var(--mono); }
  .badge.ok { background: rgba(63,185,80,.15); color: var(--ok); }
  .badge.error { background: rgba(248,81,73,.15); color: var(--err); }
  .badge.skipped { background: rgba(139,152,169,.15); color: var(--muted); }
  .badge.running { background: rgba(46,160,67,.15); color: var(--live); }
  .badge.rate_limit { background: rgba(210,153,34,.18); color: var(--warn); }
  .badge.usage_limit { background: rgba(210,153,34,.18); color: var(--warn); }
  .na { color: var(--dim); font-style: italic; }

  /* Errors */
  .err-list { display: grid; gap: 10px; }
  .err-item { background: var(--panel-2); border: 1px solid var(--border); border-left: 3px solid var(--err); border-radius: 8px; padding: 12px 14px; }
  .err-item.rate_limit { border-left-color: var(--warn); }
  .err-item.usage_limit { border-left-color: var(--warn); }
  .err-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 13px; }
  .err-msg { color: var(--muted); font-family: var(--mono); font-size: 12.5px; margin-top: 6px; white-space: pre-wrap; word-break: break-word; }
  /* Expandable long errors: the first line stays visible as the summary; the full text
     (real error at the tail) unfolds on click without blowing up the layout. */
  .err-details { margin-top: 6px; }
  .err-details > summary {
    cursor: pointer; color: var(--muted); font-family: var(--mono); font-size: 12.5px;
    white-space: pre-wrap; word-break: break-word; list-style: none;
  }
  .err-details > summary::-webkit-details-marker { display: none; }
  .err-details > summary::before { content: "\\25b8  "; color: var(--dim); }
  .err-details[open] > summary::before { content: "\\25be  "; }
  .err-details[open] > summary { color: var(--dim); }
  .err-details .err-full { margin-top: 6px; }

  .notes { color: var(--dim); font-size: 12px; margin-top: 8px; }
  .notes li { margin-bottom: 4px; }
  footer { color: var(--dim); font-size: 12px; margin-top: 40px; border-top: 1px solid var(--border); padding-top: 14px; }
</style>
</head>
<body>
  <header>
    <h1>previewer <span class="dim">/ dashboard</span></h1>
    <div class="status-line">
      <span id="conn-dot" class="dot"></span>
      <span id="conn-text">connecting…</span>
      <span id="updated"></span>
    </div>
  </header>

  <section id="system">
    <h2>System / Health</h2>
    <div id="system-cards" class="sys-cards">
      <div class="sys-card"><h3>Loading…</h3></div>
    </div>
  </section>

  <section id="reviewing">
    <h2>Reviewing now</h2>
    <div id="reviewers" class="reviewers"></div>
  </section>

  <section id="queue-sec">
    <h2>Queue</h2>
    <div id="tiles" class="tiles"></div>
  </section>

  <section id="prs-sec">
    <h2>Pull requests</h2>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Repo</th><th>PR</th><th>Head</th><th class="num">Rounds</th>
          <th class="num">Posted</th><th>Last</th><th>Engine</th><th>Findings</th><th>Updated</th>
        </tr></thead>
        <tbody id="prs-body"></tbody>
      </table>
    </div>
  </section>

  <section id="errors-sec">
    <h2>Recent errors</h2>
    <div id="errors" class="err-list"></div>
  </section>

  <section id="notes-sec">
    <h2>Notes · what the store does not persist</h2>
    <ul id="notes" class="notes"></ul>
  </section>

  <footer>Read-only · /api/status every 2s · /api/system every 10s. No mutations, no codex quota spent.</footer>

<script>
  var POLL_MS = 2000;
  var el = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var shortSha = function (s) { return s ? String(s).slice(0, 8) : "—"; };
  var ago = function (sec) {
    if (sec == null) return "";
    if (sec < 60) return sec + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m " + (sec % 60) + "s";
    return Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m";
  };
  var when = function (iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return d.toLocaleString();
  };
  var engineStr = function (runner, model, effort) {
    if (!runner && !model) return '<span class="na">n/a</span>';
    var s = esc(runner || "?");
    if (model) s += " / " + esc(model);
    if (effort) s += " · " + esc(effort);
    return '<span class="mono">' + s + "</span>";
  };

  function renderReviewers(list) {
    var host = el("reviewers");
    if (!list || !list.length) {
      host.innerHTML = '<div class="idle">Idle — no review running right now.</div>';
      return;
    }
    host.innerHTML = list.map(function (r) {
      var engine = r.runner || "(engine pending)";
      var model = r.model ? esc(r.model) + (r.reasoningEffort ? " · effort " + esc(r.reasoningEffort) : "") : "runner/model recorded on completion";
      var src = r.source ? "via " + esc(r.source) : "";
      var att = (r.attempts != null) ? "attempt " + r.attempts : "";
      return '<div class="rev-card' + (r.stale ? " stale" : "") + '">' +
        '<div class="rev-engine"><span class="pulse"></span>' + esc(engine) + (r.stale ? ' <span class="badge rate_limit">stale</span>' : "") + "</div>" +
        '<div class="rev-model">' + model + "</div>" +
        '<div class="rev-target"><b>' + esc(r.repo) + "</b> #" + r.prNumber + ' <span class="sha">@' + shortSha(r.headSha) + "</span></div>" +
        '<div class="rev-meta"><span>running ' + ago(r.ageSeconds) + "</span>" +
          (src ? "<span>" + src + "</span>" : "") + (att ? "<span>" + att + "</span>" : "") + "</div>" +
        "</div>";
    }).join("");
  }

  function tile(n, label, cls) {
    return '<div class="tile ' + (cls || "") + '"><div class="n">' + n + '</div><div class="l">' + label + "</div></div>";
  }
  function renderQueue(q) {
    el("tiles").innerHTML =
      tile(q.enqueued, "Enqueued") +
      tile(q.inFlight, "In flight", q.inFlight ? "live" : "") +
      tile(q.done, "Done") +
      tile(q.skipped, "Skipped") +
      tile(q.error, "Errors", q.error ? "err" : "") +
      tile(q.deadLetter, "Dead letter", q.deadLetter ? "warn" : "");
  }

  function renderPrs(list) {
    var body = el("prs-body");
    if (!list || !list.length) {
      body.innerHTML = '<tr><td colspan="9" class="na" style="padding:18px 14px">No reviewed PRs yet.</td></tr>';
      return;
    }
    body.innerHTML = list.map(function (p) {
      return "<tr>" +
        "<td><b>" + esc(p.repo) + "</b></td>" +
        "<td>#" + p.prNumber + "</td>" +
        '<td class="sha">' + shortSha(p.headSha) + "</td>" +
        '<td class="num">' + p.rounds + "</td>" +
        '<td class="num">' + p.posted + "</td>" +
        '<td><span class="badge ' + esc(p.lastStatus) + '">' + esc(p.lastStatus) + "</span></td>" +
        "<td>" + engineStr(p.lastRunner, p.lastModel, p.lastReasoningEffort) + "</td>" +
        '<td class="na">not stored</td>' +
        "<td>" + when(p.lastAt) + "</td>" +
        "</tr>";
    }).join("");
  }

  var kindLabel = function (kind) {
    if (kind === "usage_limit") return "usage limit";
    if (kind === "rate_limit") return "rate limit";
    return "error";
  };

  // Long / multi-line errors collapse to their first line and unfold on click, so the real
  // error (kept at the tail of the stored message) is readable without a wall of text.
  function errBody(text) {
    var full = String(text == null ? "" : text);
    var nl = full.indexOf("\\n");
    var firstLine = nl === -1 ? full : full.slice(0, nl);
    var expandable = full.length > 200 || nl !== -1;
    if (!expandable) return '<div class="err-msg">' + esc(full) + "</div>";
    return '<details class="err-details">' +
      "<summary>" + esc(firstLine) + "</summary>" +
      '<div class="err-msg err-full">' + esc(full) + "</div>" +
      "</details>";
  }

  function renderErrors(list) {
    var host = el("errors");
    if (!list || !list.length) {
      host.innerHTML = '<div class="na" style="padding:6px 2px">No recent errors.</div>';
      return;
    }
    host.innerHTML = list.map(function (e) {
      return '<div class="err-item ' + esc(e.kind) + '">' +
        '<div class="err-head"><span class="badge ' + esc(e.kind) + '">' + kindLabel(e.kind) + "</span>" +
          "<b>" + esc(e.repo) + "</b> #" + e.prNumber + ' <span class="sha">@' + shortSha(e.headSha) + "</span>" +
          (e.runner ? '<span class="mono" style="color:var(--dim)">' + esc(e.runner) + (e.model ? "/" + esc(e.model) : "") + "</span>" : "") +
          '<span style="margin-left:auto;color:var(--dim)">' + when(e.at) + "</span></div>" +
        errBody(e.error) +
        "</div>";
    }).join("");
  }

  function renderNotes(list) {
    el("notes").innerHTML = (list || []).map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("");
  }

  function setConn(ok, text) {
    var dot = el("conn-dot");
    dot.className = "dot " + (ok ? "on" : "off");
    el("conn-text").textContent = text;
  }

  // ---- System / Health (separate, slower poll) ----
  var SYSTEM_MS = 10000;

  function chip(cls, text) { return '<span class="chip ' + cls + '">' + text + "</span>"; }

  function engineCard(cfg, codex) {
    var body;
    if (!cfg) {
      body = '<div class="big"><span class="na">no repos configured</span></div>';
    } else {
      var sub = cfg.runnerModel ? esc(cfg.runnerModel) : "runner default model";
      if (cfg.runnerReasoningEffort) sub += " · effort " + esc(cfg.runnerReasoningEffort);
      body =
        '<div class="big">' + esc(cfg.runnerDefault) +
          (codex && codex.usageLimited ? " " + chip("warn", "usage-limited") : "") + "</div>" +
        '<div class="sub">' + sub + "</div>" +
        '<div class="repo">' + esc(cfg.repo) + "</div>";
    }
    return '<div class="sys-card sys-engine"><h3>Engine</h3>' + body + "</div>";
  }

  function authCard(auth, github) {
    var codex = auth.codex, claude = auth.claude;
    var codexChip = !codex.loggedIn ? chip("bad", "logged out")
      : codex.usageLimited ? chip("warn", "limited") : chip("ok", "\\u2713");
    var claudeChip = claude.tokenPresent ? chip("ok", "\\u2713") : chip("bad", "no token");
    var ghChip = !github.tokenPresent ? chip("bad", "no token")
      : chip("ok", github.rateLimit ? (github.rateLimit.remaining + "/" + github.rateLimit.limit) : "\\u2713");
    var rows =
      '<div class="kv"><span class="k">codex</span><span class="v">' + codexChip + "</span></div>" +
      '<div class="kv"><span class="k">claude</span><span class="v">' + claudeChip + "</span></div>" +
      '<div class="kv"><span class="k">github</span><span class="v">' + ghChip + "</span></div>";
    if (codex.usageLimited && codex.lastError) {
      rows += '<div class="repo" style="color:var(--dim);font-size:12px;margin-top:8px;font-family:var(--mono);white-space:pre-wrap;word-break:break-word">' +
        esc(codex.lastError) + (codex.lastErrorAt ? " (" + when(codex.lastErrorAt) + ")" : "") + "</div>";
    }
    return '<div class="sys-card"><h3>Auth</h3>' + rows + "</div>";
  }

  function servicesCard(svc) {
    var rows = (svc.services || []).map(function (s) {
      var short = esc(s.label).replace(/^com\\.nick\\.previewer-/, "");
      var c = s.running ? chip("ok", "running" + (s.pid != null ? " · " + s.pid : "")) : chip("bad", "stopped");
      return '<div class="kv"><span class="k">' + short + '</span><span class="v">' + c + "</span></div>";
    }).join("");
    if (!rows) rows = '<div class="na">launchctl unavailable</div>';
    var sweep = svc.sweepEveryHours != null
      ? '<div class="repo" style="margin-top:10px">sweep every ' + esc(svc.sweepEveryHours) + "h</div>"
      : '<div class="repo" style="margin-top:10px"><span class="na">sweep interval unknown</span></div>';
    return '<div class="sys-card"><h3>Services</h3>' + rows + sweep + "</div>";
  }

  function reposCard(list) {
    var rows;
    if (!list || !list.length) {
      rows = '<div class="na">none</div>';
    } else {
      rows = list.map(function (c) {
        var eng = esc(c.runnerDefault) + (c.runnerModel ? "/" + esc(c.runnerModel) : "");
        return '<div class="repo-row">' +
          (c.enabled ? chip("ok", "on") : chip("muted", "off")) +
          '<span class="name">' + esc(c.repo) + "</span>" +
          '<span class="eng">' + eng + "</span></div>";
      }).join("");
    }
    return '<div class="sys-card"><h3>Monitored repos</h3><div class="repo-list">' + rows + "</div></div>";
  }

  function renderSystem(s) {
    var primary = (s.reviewerConfig && s.reviewerConfig.length)
      ? (s.reviewerConfig.filter(function (c) { return c.enabled; })[0] || s.reviewerConfig[0])
      : null;
    el("system-cards").innerHTML =
      engineCard(primary, s.engineAuth.codex) +
      authCard(s.engineAuth, s.github) +
      servicesCard(s.services) +
      reposCard(s.reviewerConfig);
  }

  function pollSystem() {
    fetch("/api/system", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (s) { renderSystem(s); })
      .catch(function () { /* keep the last-known system view; /api/status drives conn state */ });
  }

  function poll() {
    fetch("/api/status", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (s) {
        renderReviewers(s.reviewers);
        renderQueue(s.queue);
        renderPrs(s.prs);
        renderErrors(s.queue ? s.queue.recentErrors : []);
        renderNotes(s.notes);
        setConn(true, "live");
        el("updated").textContent = "· updated " + new Date(s.updatedAt).toLocaleTimeString();
      })
      .catch(function (e) {
        setConn(false, "disconnected (" + e.message + ")");
      });
  }

  poll();
  setInterval(poll, POLL_MS);
  pollSystem();
  setInterval(pollSystem, SYSTEM_MS);
</script>
</body>
</html>`;
}
