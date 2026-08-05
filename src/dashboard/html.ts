/**
 * Single-page dashboard HTML. Served at `GET /` by the server. Polls
 * `GET /api/snapshot` on the same interval the CLI's `runWatch` uses — a few
 * seconds of staleness is acceptable for an operator view (dashboard-spec.md "Module:
 * Run Modes"). No build step, no framework: plain HTML/CSS/JS inlined so the
 * server has exactly one asset to serve and zero new runtime dependencies.
 *
 * Two views live here now — the original tables (`Overview`, still the default
 * landing view) and the ticker lanes (`Pipeline`, wayfinder #411/#412). Both
 * are painted from the same 3s snapshot poll; there is no second endpoint and
 * no second page.
 *
 * The lanes' rendering rules are NOT in this file. They are pure functions in
 * `pipeline-view.ts` with tests, inlined below via
 * `PIPELINE_VIEW_CLIENT_SOURCE` — nothing written inside this template literal
 * can be unit-tested, so only mounting lives here: tab switching, the click
 * handlers, the snapshot plumbing.
 */

import { PIPELINE_VIEW_CLIENT_SOURCE } from './pipeline-view.js';

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Samurai — Operator Dashboard</title>
<style>
  :root {
    --bg: #0b0e14;
    --panel: #121622;
    --panel-2: #161b29;
    --border: #232a3d;
    --text: #e6e9f0;
    --muted: #8a93a8;
    --green: #2ecc71;
    --red: #ff5c6c;
    --amber: #f5a623;
    --blue: #4aa8ff;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 22px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    position: sticky; top: 0; z-index: 10;
  }
  header h1 { font-size: 16px; margin: 0; letter-spacing: 0.5px; }
  header .sub { color: var(--muted); font-size: 12px; }
  header .meta { margin-left: auto; color: var(--muted); font-size: 12px; font-family: var(--mono); }
  .pulse {
    width: 9px; height: 9px; border-radius: 50%;
    background: var(--green); box-shadow: 0 0 0 0 rgba(46,204,113,0.6);
    animation: pulse 2s infinite;
  }
  .pulse.stale { background: var(--amber); animation: none; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(46,204,113,0.5); }
    70% { box-shadow: 0 0 0 8px rgba(46,204,113,0); }
    100% { box-shadow: 0 0 0 0 rgba(46,204,113,0); }
  }
  .tick-banner {
    background: #1a2236; border-bottom: 1px solid var(--border);
    padding: 8px 22px; font-size: 13px; color: var(--blue);
    font-family: var(--mono);
  }
  main {
    padding: 16px 22px;
    max-width: 1600px;
    margin: 0 auto;
  }
  /* The Overview panel keeps the two-column grid the tables were laid out for;
     the Pipeline panel is one full-width table and wants no grid at all. */
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  /* Must out-specify '.grid': a class-level 'display' beats the UA stylesheet's
     [hidden] rule, which would leave the inactive panel on screen. */
  .tabpanel[hidden] { display: none; }
  .tabpanel:focus-visible { outline-offset: -2px; }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .panel h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--muted); margin: 0; padding: 10px 14px;
    border-bottom: 1px solid var(--border); background: var(--panel-2);
    display: flex; justify-content: space-between; align-items: center;
  }
  .panel h2 .count { color: var(--text); font-family: var(--mono); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 7px 14px; text-align: right; white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  td:first-child, th:first-child { text-align: left; }
  tr { border-bottom: 1px solid var(--border); }
  tr:last-child { border-bottom: none; }
  .mono { font-family: var(--mono); }
  .pos { color: var(--green); }
  .neg { color: var(--red); }
  .neu { color: var(--muted); }
  .badge {
    display: inline-block; padding: 1px 7px; border-radius: 4px;
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .badge-go { background: rgba(46,204,113,0.15); color: var(--green); }
  .badge-no_go { background: rgba(255,92,108,0.15); color: var(--red); }
  .badge-bullish { background: rgba(46,204,113,0.15); color: var(--green); }
  .badge-bearish { background: rgba(255,92,108,0.15); color: var(--red); }
  .badge-neutral { background: rgba(138,147,168,0.18); color: var(--muted); }
  .empty { padding: 18px 14px; color: var(--muted); text-align: center; }
  .metrics-grid { display: grid; grid-template-columns: repeat(2,1fr); gap: 1px; background: var(--border); }
  .metric { background: var(--panel); padding: 10px 14px; }
  .metric .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); }
  .metric .value { font-family: var(--mono); font-size: 16px; margin-top: 2px; }
  .prov-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 1px; background: var(--border); }
  .prov { background: var(--panel); padding: 12px 14px; }
  .prov .name { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); display: flex; align-items: center; gap: 7px; }
  .prov .figure { font-family: var(--mono); font-size: 18px; margin-top: 6px; }
  .prov .sub { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 3px; }
  .prov .note { font-size: 11px; color: var(--muted); margin-top: 7px; font-style: italic; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot-ok { background: var(--green); }
  .dot-warn { background: var(--amber); }
  .dot-bad { background: var(--red); }
  .dot-off { background: var(--muted); }
  .caveat { color: var(--amber); }
  @media (max-width: 900px) { .prov-grid { grid-template-columns: 1fr; } }
  .full { grid-column: 1 / -1; }
  .hitl { color: var(--amber); font-size: 11px; margin-left: 6px; }
  .reason { color: var(--muted); font-size: 12px; }
  footer { color: var(--muted); font-size: 11px; padding: 12px 22px 24px; text-align: center; }

  /* ---------------- tab strip (Overview | Pipeline) ---------------- */
  .tabs { display: flex; gap: 2px; padding: 0 22px; background: var(--panel); border-bottom: 1px solid var(--border); }
  .tab {
    padding: 9px 16px; font: inherit; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--muted); background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer;
  }
  .tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--blue); }
  .tab:hover { color: var(--text); }
  /* One rule covers every control on the page: the lane cells, the lane
     toggles, the tabs and the drawer's close button are all real buttons. */
  :focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; border-radius: 3px; }

  /* ---------------- pipeline: ticker lanes ---------------- */
  /* Seven columns is wide; the table scrolls inside the panel rather than the page. */
  .pl-scroll { overflow-x: auto; }
  .pl-lanes { width: 100%; border-collapse: collapse; font-size: 13px; }
  .pl-lanes th {
    color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
    padding: 9px 10px; text-align: center; border-bottom: 1px solid var(--border); white-space: nowrap;
  }
  .pl-lanes th.pl-name { text-align: left; }
  .pl-lanes th.pl-outcome, .pl-lanes td.pl-outcome { text-align: right; padding-right: 14px; white-space: nowrap; }
  .pl-lanes td { padding: 0; border-bottom: 1px solid var(--border); }
  .pl-lanes tr:last-child td { border-bottom: none; }
  .pl-lanes tr.pl-selected { background: var(--panel-2); }
  /* Dormant, not absent: a stock outside market hours has a row, dimmed. */
  .pl-lanes tr.pl-dormant td { opacity: 0.5; }
  .pl-toggle {
    display: block; width: 100%; text-align: left; padding: 10px 14px; white-space: nowrap;
    font-family: var(--mono); font-size: 13px; color: var(--text); background: none; border: none; cursor: pointer;
  }
  .pl-class { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin-left: 7px; }
  .pl-hit { display: block; width: 100%; padding: 10px 6px; background: none; border: none; cursor: pointer; }
  .pl-hit.pl-inert { cursor: default; }
  .pl-seg {
    position: relative; display: flex; align-items: center; justify-content: center;
    height: 22px; min-width: 46px; border-radius: 4px; background: var(--panel-2); border: 1px solid var(--border);
    font-family: var(--mono); font-size: 11px; color: var(--muted);
  }
  .pl-done { background: rgba(46,204,113,0.13); border-color: rgba(46,204,113,0.4); color: var(--green); }
  .pl-live { background: rgba(74,168,255,0.16); border-color: var(--blue); color: var(--blue); }
  .pl-stopped { background: rgba(255,92,108,0.13); border-color: rgba(255,92,108,0.45); color: var(--red); }
  /* Skipped is dashed-but-legible; not_reached is dashed-and-faint. They must
     never be confusable — a skipped Invalidation is normal traffic. */
  .pl-skipped { background: transparent; border-style: dashed; border-color: var(--border); color: var(--muted); }
  .pl-not_reached { background: transparent; border-style: dashed; border-color: var(--border); color: #3a4157; }
  .pl-retry {
    position: absolute; top: -5px; right: -5px; background: var(--amber); color: #1a1200;
    font-size: 9px; font-weight: 700; border-radius: 7px; padding: 0 4px; line-height: 13px;
  }
  .pl-idle { color: var(--muted); font-size: 11px; }
  .badge-live { background: rgba(74,168,255,0.16); color: var(--blue); }
  .pl-empty { padding: 18px 14px; color: var(--muted); text-align: center; }

  /* ---------------- pipeline: motion (#421) ----------------
     The view has two snapshots, never the moment between them, so nothing
     travels: a cell that changed state gets one ring that fades, which says
     "this is new since the last poll" and claims nothing about the path. */
  .pl-settle { animation: pl-settle 900ms ease-out 1; }
  @keyframes pl-settle {
    0% { box-shadow: 0 0 0 2px rgba(74,168,255,0.6); }
    100% { box-shadow: 0 0 0 2px rgba(74,168,255,0); }
  }
  @media (prefers-reduced-motion: reduce) {
    /* Same information, held still: the ring stays for the poll instead of
       fading, and the header stops pulsing. */
    .pl-settle { animation: none; box-shadow: 0 0 0 2px rgba(74,168,255,0.6); }
    .pulse, .pulse.stale { animation: none; }
  }

  /* ---------------- pipeline: drawer ---------------- */
  .pl-drawer { border-top: 1px solid var(--border); background: var(--panel-2); padding: 14px 18px; }
  .pl-drawer-empty { color: var(--muted); font-size: 12px; }
  .pl-drawer-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; margin-bottom: 12px; }
  .pl-close { margin-left: auto; font: inherit; font-size: 11px; color: var(--muted); background: none; border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; cursor: pointer; }
  .pl-close:hover { color: var(--text); }
  .pl-drawer h3 { margin: 14px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
  .pl-sub { color: var(--muted); font-size: 11px; text-transform: none; letter-spacing: 0; }
  .pl-strip { width: 100%; border-collapse: collapse; font-size: 12px; }
  .pl-strip th { color: var(--muted); font-weight: 500; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; padding: 5px 10px; text-align: left; }
  .pl-strip td { padding: 5px 10px; border-top: 1px solid var(--border); text-align: left; }
  .pl-state { display: inline-block; padding: 0 6px; border-radius: 4px; border: 1px solid transparent; font-size: 11px; }
  .pl-decision { color: var(--muted); }
  .pl-retry-flat { color: var(--amber); font-size: 11px; }
  .pl-agents { display: flex; gap: 10px; flex-wrap: wrap; }
  .pl-agent { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 9px 12px; min-width: 168px; }
  .pl-who { font-family: var(--mono); font-size: 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .pl-role { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-top: 3px; }
  .pl-inf { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 6px; }
  .pl-bar { height: 4px; background: var(--border); border-radius: 2px; margin-top: 4px; overflow: hidden; }
  .pl-bar i { display: block; height: 100%; background: var(--blue); }
  /* An empty state that states its reason. Never a spinner or a skeleton —
     both promise detail that is not coming (Debate Engine decision #10). */
  .pl-note { border: 1px dashed var(--border); border-radius: 6px; padding: 10px 12px; font-size: 12px; color: var(--text); }
  .pl-note.pl-reserved { border-color: var(--amber); color: var(--amber); background: rgba(245,166,35,0.05); }
  .pl-why { color: var(--muted); display: block; margin-top: 4px; font-size: 11px; }
  .pl-foot { color: var(--muted); font-size: 11px; margin: 10px 0 0; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <div class="pulse" id="pulse"></div>
  <h1>Samurai</h1>
  <span class="sub">multi-agent trading system · operator dashboard</span>
  <span class="meta" id="meta">loading…</span>
</header>
<div class="tick-banner" id="tick-banner" style="display:none;"></div>
<div class="tabs" role="tablist" aria-label="Dashboard views" id="tabs">
  <button type="button" class="tab" id="tab-overview" role="tab" data-tab="overview"
          aria-controls="view-overview" aria-selected="true">Overview</button>
  <button type="button" class="tab" id="tab-pipeline" role="tab" data-tab="pipeline"
          aria-controls="view-pipeline" aria-selected="false">Pipeline</button>
</div>
<main>
<div class="tabpanel grid" id="view-overview" role="tabpanel" aria-labelledby="tab-overview" tabindex="0">
  <section class="panel full">
    <h2>Providers <span class="count">live probe · 60s</span></h2>
    <div class="prov-grid" id="providers"></div>
  </section>
  <section class="panel">
    <h2>Open Positions <span class="count" id="pos-count"></span></h2>
    <div id="positions"></div>
  </section>
  <section class="panel">
    <h2>Daily Metrics <span class="count">feedback loop</span></h2>
    <div class="metrics-grid" id="metrics"></div>
  </section>
  <section class="panel full">
    <h2>Recent Debates <span class="count" id="debate-count"></span></h2>
    <div id="debates"></div>
  </section>
  <section class="panel full">
    <h2>Verdict History <span class="count" id="verdict-count"></span></h2>
    <div id="verdicts"></div>
  </section>
  <section class="panel full">
    <h2>Analyst Performance <span class="count" id="analyst-count"></span></h2>
    <div id="analysts"></div>
  </section>
</div>
<div class="tabpanel" id="view-pipeline" role="tabpanel" aria-labelledby="tab-pipeline" tabindex="0" hidden>
  <section class="panel" id="pl-panel">
    <h2>Pipeline by ticker <span class="count" id="pl-count">—</span></h2>
    <div class="pl-scroll" id="pl-lanes"><div class="pl-empty">loading…</div></div>
    <div id="pl-drawer"></div>
  </section>
</div>
</main>
<footer>Read-only operator view · same data as <code>samurai status</code> · polling every 3s</footer>

<script>
const POLL_MS = 3000;
let lastOk = 0;

function fmt(n, dp) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dp ?? 2, maximumFractionDigits: dp ?? 2 });
}
function pnlClass(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'neu'; }
function badge(cls, text) { return '<span class="badge badge-' + cls + '">' + text + '</span>'; }
function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function renderPositions(data) {
  const el = document.getElementById('positions');
  document.getElementById('pos-count').textContent = data.length;
  if (!data.length) { el.innerHTML = '<div class="empty">No open positions.</div>'; return; }
  let rows = data.map(p => {
    const pnl = p.unrealized_pnl;
    return '<tr><td class="mono">' + p.instrument + '</td><td>' + (p.side === 'buy' ? 'LONG' : 'SHORT') +
      '</td><td class="mono">' + fmt(p.filled_size) + '</td><td class="mono">' + fmt(p.avg_entry_price) +
      '</td><td class="mono">' + fmt(p.stop) + '</td><td class="mono">' + fmt(p.target) +
      '</td><td class="mono">' + fmt(p.mark_price) + '</td><td class="mono ' + pnlClass(pnl) + '">' +
      (pnl >= 0 ? '+' : '') + fmt(pnl) + '</td></tr>';
  }).join('');
  el.innerHTML = '<table><thead><tr><th>Instrument</th><th>Side</th><th>Size</th><th>Entry</th><th>Stop</th><th>Target</th><th>Mark</th><th>uPnL</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderMetrics(m) {
  const items = [
    ['Sharpe', m.sharpe], ['Sortino', m.sortino], ['Calmar', m.calmar], ['Max DD', (m.max_drawdown*100).toFixed(1)+'%'],
    ['Profit Factor', m.profit_factor], ['Expectancy', '$'+fmt(m.expectancy)],
    ['Skew', m.skew], ['Kurtosis', m.kurtosis], ['Turnover', m.turnover], ['Exposure', (m.exposure*100).toFixed(0)+'%'],
  ];
  document.getElementById('metrics').innerHTML = items.map(([k,v]) =>
    '<div class="metric"><div class="label">' + k + '</div><div class="value">' + v + '</div></div>').join('');
}

function renderDebates(data) {
  const el = document.getElementById('debates');
  document.getElementById('debate-count').textContent = data.length;
  if (!data.length) { el.innerHTML = '<div class="empty">No completed debates.</div>'; return; }
  let rows = data.map(d => {
    const contribs = d.contributions.map(c =>
      '<span class="mono" style="margin-right:10px;font-size:11px;">' + c.analyst_id + ' ' + badge(c.final_position, c.final_position[0].toUpperCase()) + ' <span class="reason">inf ' + fmt(c.influence_score) + '</span></span>').join('');
    return '<tr><td class="mono">' + d.instrument + '</td><td>' + badge(d.direction, d.direction) +
      '</td><td class="mono">' + d.rounds + '</td><td class="reason">' + timeAgo(d.created_at) +
      '</td><td style="text-align:left;">' + contribs + '</td></tr>';
  }).join('');
  el.innerHTML = '<table><thead><tr><th>Instrument</th><th>Direction</th><th>Rounds</th><th>When</th><th style="text-align:left;">Contributions</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderVerdicts(data) {
  const el = document.getElementById('verdicts');
  document.getElementById('verdict-count').textContent = data.length;
  if (!data.length) { el.innerHTML = '<div class="empty">No verdict history.</div>'; return; }
  let rows = data.map(v => '<tr><td class="reason">' + new Date(v.timestamp).toISOString().slice(11,19) + 'Z</td><td class="mono">' +
    v.instrument + '</td><td>' + badge(v.status, v.status.toUpperCase()) + '</td><td class="reason">' + v.reason +
    (v.hitl_override ? '<span class="hitl">HITL</span>' : '') + '</td><td class="reason mono">' + v.trace_id + '</td></tr>').join('');
  el.innerHTML = '<table><thead><tr><th>Time</th><th>Instrument</th><th>Verdict</th><th>Gate</th><th>Trace</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderAnalysts(data) {
  const el = document.getElementById('analysts');
  document.getElementById('analyst-count').textContent = data.length;
  if (!data.length) { el.innerHTML = '<div class="empty">No analyst data.</div>'; return; }
  let rows = data.map(a => '<tr><td class="mono">' + a.analyst_id + '</td><td class="mono">' + fmt(a.weight) +
    '</td><td class="mono ' + pnlClass(a.rolling_r) + '">' + (a.rolling_r>=0?'+':'') + fmt(a.rolling_r) +
    'R</td><td class="reason">' + a.window_days + 'd</td></tr>').join('');
  el.innerHTML = '<table><thead><tr><th>Analyst</th><th>Weight</th><th>Rolling R</th><th>Window</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

// Only Alpaca has a balance. Polygon publishes no balance/credits endpoint at
// all, and Anthropic publishes no credit-balance endpoint either, so those two
// tiles show the honest substitutes — reachability, and locally-metered spend —
// and say so on the tile rather than dressing them up as balances.
const STATE_DOT = { ok: 'dot-ok', rate_limited: 'dot-warn', unauthorized: 'dot-bad',
                    forbidden: 'dot-bad', error: 'dot-bad', not_configured: 'dot-off' };

function usd(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function compact(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
}
// One decision costs cents, not dollars (#326). The two decimals 'usd' uses
// would render every per-debate figure as '$0.03' and hide the difference
// between a median debate and a p95 one — the whole point of showing both.
function usdPrecise(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}
// LLM latency runs to tens of seconds per debate; ms would be an unreadable
// five-digit number on a tile read at a glance.
function secs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  return (Number(ms) / 1000).toFixed(1) + 's';
}
// Provider 'detail' strings carry third-party error text straight into innerHTML.
// Escaped rather than trusted: the rest of this page renders values this system
// wrote, and these are the only ones it did not.
function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
}
function provHeader(label, state) {
  return '<div class="name"><span class="dot ' + (STATE_DOT[state] || 'dot-off') + '"></span>' + label + '</div>';
}

function renderProviders(p, spend) {
  const a = p.alpaca;
  // The balance renders only when the probe actually succeeded — a last-known
  // figure beside a failed probe reads as current, which on money is the one
  // wrong answer that looks like a right one.
  const alpacaOk = a.state === 'ok' && a.balance;
  const alpacaFigure = alpacaOk ? usd(a.balance.equity)
    : '<span class="caveat">' + esc(a.state.replace('_', ' ')) + '</span>';
  const alpacaSub = alpacaOk
    ? 'cash ' + usd(a.balance.cash) +
      (a.balance.buying_power !== null ? ' · bp ' + usd(a.balance.buying_power) : '')
    : esc(a.detail);
  const alpacaTile = '<div class="prov">' + provHeader('Alpaca · equity', a.state) +
    '<div class="figure">' + alpacaFigure + '</div>' +
    '<div class="sub">' + alpacaSub + '</div>' +
    '<div class="note">' + (a.observed_at ? 'probed ' + timeAgo(a.observed_at) : 'not probed yet') +
    '</div></div>';

  const g = p.polygon;
  const polygonTile = '<div class="prov">' + provHeader('Polygon · status', g.state) +
    '<div class="figure">' + esc(g.state.replace('_', ' ')) + '</div>' +
    '<div class="sub">' + esc(g.detail) + '</div>' +
    '<div class="note">no balance API — subscription plan, health only</div></div>';

  const w = spend.last_24h;
  const unpriced = w.unpriced_calls > 0
    ? '<div class="sub caveat">' + w.unpriced_calls + ' unpriced call(s) — figure is a floor</div>'
    : '';
  const anthropicTile = '<div class="prov">' + provHeader('Anthropic · spend 24h', 'ok') +
    '<div class="figure">' + usd(w.cost_usd) + '</div>' +
    '<div class="sub">' + w.calls + ' calls · ' + compact(w.input_tokens) + ' in / ' +
      compact(w.output_tokens) + ' out · 7d ' + usd(spend.last_7d.cost_usd) +
      ' · all ' + usd(spend.all_time.cost_usd) + '</div>' + unpriced +
    '<div class="note">no balance API — metered locally, this bot only</div></div>';

  // Per-DECISION cost and LLM latency (#326). A separate tile rather than more
  // sub-text on the spend one: the window total answers "what is this costing
  // me", this answers "what does one decision cost, and is the third round
  // earning its latency" — the question the paper soak exists to settle.
  //
  // The 24h window, matching the tile beside it. Zero debates is the normal
  // pre-first-debate state and renders as a caveat rather than as '$0.0000 /
  // 0.0s', which would read as a decision that cost nothing.
  const d = spend.last_24h.per_debate;
  const perDebateFigure = d.debates > 0
    ? usdPrecise(d.cost_usd_p50) + ' <span class="sub">p50</span>'
    : '<span class="caveat">no debates yet</span>';
  const perDebateSub = d.debates > 0
    ? d.debates + ' debates · cost p95 ' + usdPrecise(d.cost_usd_p95) +
      ' · llm time p50 ' + secs(d.llm_latency_ms_p50) + ' / p95 ' + secs(d.llm_latency_ms_p95)
    : 'no metered debate in the last 24h';
  // Same posture as the unpriced caveat above: an omission the figures depend
  // on is shown, not swallowed.
  const unattributed = d.unattributed_calls > 0
    ? '<div class="sub caveat">' + d.unattributed_calls +
      ' call(s) not attributed to a debate — excluded from these percentiles</div>'
    : '';
  const perDebateTile = '<div class="prov">' + provHeader('Anthropic · per decision 24h', 'ok') +
    '<div class="figure">' + perDebateFigure + '</div>' +
    '<div class="sub">' + perDebateSub + '</div>' + unattributed +
    '<div class="note">llm time is summed per-call latency, not debate wall clock</div></div>';

  document.getElementById('providers').innerHTML =
    alpacaTile + polygonTile + anthropicTile + perDebateTile;
}

function renderTick(t) {
  const el = document.getElementById('tick-banner');
  if (!t) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.textContent = '▶ tick in progress: ' + t.instrument + ' · stage=' + t.stage + ' · trace=' + t.trace_id;
}

/* ------------------------------------------------------------------ *
 * PIPELINE VIEW — the render rules, inlined verbatim from
 * src/dashboard/pipeline-view.ts. Everything between here and the
 * mounting block below is generated: edit the TypeScript module and its
 * tests, never this output.
 * ------------------------------------------------------------------ */
${PIPELINE_VIEW_CLIENT_SOURCE}

/* ---------------- pipeline mounting ---------------- */
// Selection is keyed by INSTRUMENT, never by trace_id: a new tick rotates the
// trace every few minutes and a drawer that closed itself on each one would be
// unusable. Keying by instrument is also the answer to "follow one ticker" —
// the drawer stays on the ticker as its ticks come and go.
let plSelected = null;
let plData = null;
let plPrev = null;
let plDebates = [];
let plLastLanes = '';
let plLastDrawer = '';

// Wholesale innerHTML replacement drops keyboard focus. The lane cells are real
// buttons, so an operator tabbing the table would lose their place every 3s.
function plFocusKey() {
  const el = document.activeElement;
  if (!el || !el.closest || !el.closest('#pl-lanes') || !el.dataset || !el.dataset.instrument) return null;
  return el.dataset.instrument + '|' + (el.dataset.stage || '');
}
function plRestoreFocus(key) {
  if (!key) return;
  const cut = key.lastIndexOf('|');
  const inst = CSS.escape(key.slice(0, cut));
  const stage = key.slice(cut + 1);
  const sel = stage
    ? '#pl-lanes .pl-hit[data-instrument="' + inst + '"][data-stage="' + stage + '"]'
    : '#pl-lanes .pl-toggle[data-instrument="' + inst + '"]';
  const el = document.querySelector(sel);
  if (el) el.focus();
}

function paintPipeline(changed) {
  const lanes = document.getElementById('pl-lanes');
  const drawer = document.getElementById('pl-drawer');
  if (!plData) {
    lanes.innerHTML = '<div class="pl-empty">This snapshot carries no pipeline data.</div>';
    drawer.innerHTML = '';
    document.getElementById('pl-count').textContent = '—';
    plLastLanes = '';
    plLastDrawer = '';
    return;
  }
  const html = renderPipelineLanes(plData, {
    selectedInstrument: plSelected,
    nowMs: Date.now(),
    changedCells: changed,
  });
  if (html !== plLastLanes) {
    const focus = plFocusKey();
    lanes.innerHTML = html;
    plLastLanes = html;
    plRestoreFocus(focus);
  }
  const drawerHtml = renderPipelineDrawer(findPipelineLane(plData, plSelected), plDebates);
  if (drawerHtml !== plLastDrawer) {
    drawer.innerHTML = drawerHtml;
    plLastDrawer = drawerHtml;
  }
  document.getElementById('pl-count').textContent = plData.lanes.length + ' instruments';
}

function renderPipeline(view, debates) {
  plPrev = plData;
  plData = view || null;
  plDebates = debates || [];
  // A first paint reports no changes at all — see diffPipelineCells.
  paintPipeline(plData ? diffPipelineCells(plPrev, plData) : []);
}

// One delegated handler: the rows are replaced wholesale, so per-element
// listeners would leak with every poll.
document.getElementById('pl-panel').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) { plSelected = null; paintPipeline([]); return; }
  const hit = e.target.closest('.pl-hit[data-instrument], .pl-toggle[data-instrument]');
  if (!hit) return;
  const instrument = hit.dataset.instrument;
  plSelected = plSelected === instrument ? null : instrument;
  // Repaint immediately with an empty diff: a click is not new data, so
  // nothing should flash as changed.
  paintPipeline([]);
});

/* ---------------- tabs ---------------- */
// Overview is the default landing view and stays that way (#412). No hash
// routing: this is one page with two panels, not two pages.
function showTab(name) {
  const pipeline = name === 'pipeline';
  document.getElementById('view-overview').hidden = pipeline;
  document.getElementById('view-pipeline').hidden = !pipeline;
  const tabs = document.querySelectorAll('.tab');
  for (const t of tabs) t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false');
}
document.getElementById('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) showTab(tab.dataset.tab);
});
document.getElementById('tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const next = e.key === 'ArrowRight' ? 'tab-pipeline' : 'tab-overview';
  document.getElementById(next).focus();
  showTab(document.getElementById(next).dataset.tab);
});

async function poll() {
  try {
    const r = await fetch('/api/snapshot', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const s = await r.json();
    lastOk = Date.now();
    document.getElementById('pulse').classList.remove('stale');
    document.getElementById('meta').textContent = 'as of ' + new Date(s.as_of).toLocaleTimeString() + ' · ' + new Date(s.generated_at).toLocaleTimeString();
    renderProviders(s.providers, s.llm_spend);
    renderTick(s.tick_status);
    renderPositions(s.positions);
    renderMetrics(s.metrics);
    renderDebates(s.debates);
    renderVerdicts(s.verdicts);
    renderAnalysts(s.analysts);
    // Last, and in its own guard. The pipeline field is newer than the rest of
    // the snapshot; if it is missing or malformed, the tables above must still
    // update rather than the whole poll reporting a connection error.
    try {
      renderPipeline(s.pipeline, s.debates);
    } catch (pe) {
      document.getElementById('pl-lanes').innerHTML =
        '<div class="pl-empty">Pipeline view failed to render: ' + esc(pe.message) + '</div>';
    }
  } catch (e) {
    document.getElementById('pulse').classList.add('stale');
    document.getElementById('meta').textContent = 'connection error: ' + e.message;
  }
}
poll();
setInterval(poll, POLL_MS);
setInterval(() => {
  if (Date.now() - lastOk > POLL_MS * 2) document.getElementById('pulse').classList.add('stale');
}, 1000);
</script>
</body>
</html>`;
