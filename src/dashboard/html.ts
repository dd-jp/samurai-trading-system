/**
 * Single-page dashboard HTML. Served at `GET /` by the server. Polls
 * `GET /api/snapshot` on the same interval the CLI's `runWatch` uses — a few
 * seconds of staleness is acceptable for an operator view (dashboard-spec.md "Module:
 * Run Modes"). No build step, no framework: plain HTML/CSS/JS inlined so the
 * server has exactly one asset to serve and zero new runtime dependencies.
 */

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
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    padding: 16px 22px;
    max-width: 1600px;
    margin: 0 auto;
  }
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
  .full { grid-column: 1 / -1; }
  .hitl { color: var(--amber); font-size: 11px; margin-left: 6px; }
  .reason { color: var(--muted); font-size: 12px; }
  footer { color: var(--muted); font-size: 11px; padding: 12px 22px 24px; text-align: center; }
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
<main>
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

function renderTick(t) {
  const el = document.getElementById('tick-banner');
  if (!t) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.textContent = '▶ tick in progress: ' + t.instrument + ' · stage=' + t.stage + ' · trace=' + t.trace_id;
}

async function poll() {
  try {
    const r = await fetch('/api/snapshot', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const s = await r.json();
    lastOk = Date.now();
    document.getElementById('pulse').classList.remove('stale');
    document.getElementById('meta').textContent = 'as of ' + new Date(s.as_of).toLocaleTimeString() + ' · ' + new Date(s.generated_at).toLocaleTimeString();
    renderTick(s.tick_status);
    renderPositions(s.positions);
    renderMetrics(s.metrics);
    renderDebates(s.debates);
    renderVerdicts(s.verdicts);
    renderAnalysts(s.analysts);
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
