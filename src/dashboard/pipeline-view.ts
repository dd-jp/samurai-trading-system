/**
 * Render layer for the dashboard's Pipeline view — a **stage rail**: seven
 * fixed stations, tickers as chips sitting on the station they last reached
 * (wayfinder map #411, primitive decided in #412).
 *
 * Reads `PipelineView` from `pipeline-types.ts`; knows nothing about where
 * those shapes came from.
 *
 * **What the rail answers, and what it gives up.** The rail reads as the
 * system-as-machine: where the load is, and where ticks die. Four chips piled
 * on Risk is the diagnostic that makes this primitive worth choosing. The cost
 * is that one ticker's own journey is no longer a row you can read across —
 * a chip is a single point, so a stage the ticker *skipped* and a stage it
 * retried are not renderable on the rail at all. Both live in the drawer's
 * stage strip instead, which under this primitive stops being supplementary
 * detail and becomes the **sole per-stage record**. That is an accepted
 * consequence of #412, not an oversight: `renderStageStrip` must keep listing
 * all seven stages with state, duration and decision.
 *
 * **Why this file exists at all.** `html.ts` is one inlined template literal
 * with no build step, so nothing in it can be unit-tested — a rendering rule
 * written there is a rule nobody can assert on. The rail carries real
 * decisions (a skipped stage must not read as a stopped one; an idle ticker
 * must not vanish), so the rules live here as plain functions with tests, and
 * `html.ts` keeps only the mounting.
 *
 * **How pure functions reach the browser.** The dashboard has zero runtime
 * dependencies and no bundler, so these functions are shipped by serialising
 * them — `PIPELINE_VIEW_CLIENT_SOURCE` is the module's own
 * `Function.prototype.toString()` output, inlined into the page's `<script>`.
 * The code the browser runs is therefore the same code vitest ran, byte for
 * byte, which `pipeline-view.test.ts` asserts by evaluating that source and
 * comparing its output against the imported functions. The constraints that
 * follow from it: every exported render function must be a `function`
 * declaration (an arrow assigned to a const stringifies without its name),
 * must reference only module-level constants declared below, and must be pure
 * — no `Date.now()`, no DOM.
 *
 * Everything here is read-only by construction. Nothing in the view may imply
 * an action on a trade, so nothing rendered is a form, a link or a write.
 */

import {
  PIPELINE_STAGES,
  type PipelineCell,
  type PipelineLane,
  type PipelineStage,
  type PipelineView,
} from './pipeline-types.js';

/**
 * The contract's stage order, rebound to a module-local name.
 *
 * Not cosmetic: a serialised function may reference module-local constants but
 * never an **import binding**. Toolchains rewrite imported identifiers inside
 * function bodies — vitest's SSR transform turns `PIPELINE_STAGES` into
 * `__vite_ssr_import_0__.PIPELINE_STAGES` — and that rewritten name is what
 * `Function.prototype.toString()` would then hand the browser. One local
 * rebinding keeps the emitted source free of every such artefact, whatever
 * compiles it. `pipeline-view.test.ts` fails loudly if this is undone.
 */
const PIPELINE_STAGE_ORDER: readonly PipelineStage[] = PIPELINE_STAGES;

/** Station headings. Title case to match the existing table headers' density. */
const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  analysts: 'Analysts',
  debate: 'Debate',
  trader: 'Trader',
  invalidation: 'Invalid.',
  risk: 'Risk',
  verdict: 'Verdict',
  execution: 'Execution',
};

/**
 * Stages that persist nothing beyond an `audit_log` digest, so their drill-down
 * is an honest empty slot rather than invented content (Tier 2 of #411; the
 * payload is owned by the decision-record map #328). Marked on the station head
 * as well as in the drawer: a chip parked on Trader otherwise looks like it has
 * detail waiting behind it.
 */
const PIPELINE_RESERVED_STAGES: PipelineStage[] = ['trader', 'invalidation', 'risk'];

/**
 * One completed debate, as the snapshot already carries it.
 *
 * Declared structurally rather than importing `DebateRow` from `types.ts`: that
 * file is owned by the query half of this feature. This is the subset the
 * drawer actually reads, and TypeScript checks it structurally at the call site
 * in either case.
 */
export interface PipelineDebateContribution {
  analyst_id: string;
  analyst_type: string;
  final_position: string;
  influence_score: number;
}

export interface PipelineDebateSummary {
  instrument: string;
  direction: string;
  rounds: number;
  created_at: string;
  contributions: PipelineDebateContribution[];
}

/** Everything the rail renderer needs that is not in `PipelineView` itself. */
export interface PipelineRenderOptions {
  /** The ticker whose drawer is open, or `null`. Keyed by instrument, never by trace. */
  selectedInstrument: string | null;
  /** `Date.now()` at the poll, passed in so the renderer stays pure. */
  nowMs: number;
  /**
   * `instrument|stage` keys whose cell state changed since the previous poll,
   * from `diffPipelineCells`. These get the one-shot settle highlight (#421).
   */
  changedCells: readonly string[];
}

/**
 * Third-party text never reaches this view, but instrument names, decision
 * words and analyst ids all come from the database and go into `innerHTML`.
 * Escaped for the same reason `html.ts` escapes provider detail: a value this
 * system merely stored is not a value it wrote.
 */
export function escapePipelineText(value: string): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/**
 * Stage durations span three orders of magnitude — Verdict is ~100ms against a
 * ~9s Debate — so a single unit would render either as noise. Sub-second stays
 * in ms because the difference between 95ms and 410ms is the point; anything
 * longer reads in seconds.
 */
export function formatStageDuration(ms: number | null): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '·';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  return `${mins}m ${Math.round((ms - mins * 60000) / 1000)}s`;
}

/** The diff key for one cell. Instrument-scoped, so chips can move freely. */
export function pipelineCellKey(instrument: string, stage: string): string {
  return `${instrument}|${stage}`;
}

/** Lookup rather than index: `cells` is contract-ordered, but nothing enforces it at runtime. */
export function findPipelineCell(lane: PipelineLane, stage: PipelineStage): PipelineCell | null {
  for (const cell of lane.cells) {
    if (cell.stage === stage) return cell;
  }
  return null;
}

export function findPipelineLane(
  view: PipelineView,
  instrument: string | null,
): PipelineLane | null {
  if (instrument === null) return null;
  for (const lane of view.lanes) {
    if (lane.instrument === instrument) return lane;
  }
  return null;
}

/**
 * What changed between two polls — the only input to motion in this view (#421).
 *
 * A first paint (`previous === null`) reports nothing: every cell is new, and
 * flashing the whole rail would signal change where there is only arrival.
 */
export function diffPipelineCells(previous: PipelineView | null, next: PipelineView): string[] {
  if (previous === null) return [];
  const changed: string[] = [];
  for (const lane of next.lanes) {
    const before = findPipelineLane(previous, lane.instrument);
    if (before === null) continue;
    for (const cell of lane.cells) {
      const wasCell = findPipelineCell(before, cell.stage);
      if (wasCell === null) continue;
      // A new trace re-runs the same stages, so the trace_id is part of "changed":
      // analysts→analysts across two different ticks is new information.
      const stateChanged = wasCell.state !== cell.state || wasCell.attempts !== cell.attempts;
      const traceChanged = before.trace_id !== lane.trace_id && cell.state !== 'not_reached';
      if (stateChanged || traceChanged) changed.push(pipelineCellKey(lane.instrument, cell.stage));
    }
  }
  return changed;
}

/**
 * Did anything about this ticker move on this poll?
 *
 * The diff is cell-keyed because the contract is, but a chip is one point: the
 * rail cannot highlight "the Risk cell" of a chip parked on Verdict. Any
 * changed cell belonging to the instrument settles that instrument's chip.
 */
export function pipelineLaneChanged(instrument: string, changedCells: readonly string[]): boolean {
  const prefix = `${instrument}|`;
  for (const key of changedCells) {
    if (key.indexOf(prefix) === 0) return true;
  }
  return false;
}

/**
 * Which station this ticker's chip sits on — the whole placement rule.
 *
 * `live` wins outright: an in-flight ticker belongs where it is now, not where
 * it has been. Otherwise the chip parks on the furthest stage the trace
 * actually reached, which for a settled trace is where it stopped. A `skipped`
 * stage is explicitly not a station a chip can sit on — the tick passed
 * through without running it, so parking a chip there would claim work that
 * never happened. `null` means the ticker has no trace in the window at all
 * and belongs in the idle group, never nowhere (#413: an idle instrument must
 * read as idle, not as absent).
 */
export function pipelineStationFor(lane: PipelineLane): PipelineStage | null {
  let furthest: PipelineStage | null = null;
  for (const stage of PIPELINE_STAGE_ORDER) {
    const cell = findPipelineCell(lane, stage);
    if (cell === null) continue;
    if (cell.state === 'live') return stage;
    if (cell.state === 'done' || cell.state === 'stopped') furthest = stage;
  }
  return furthest;
}

/** How a trace ended, as a badge. Reuses the existing `.badge-*` vocabulary. */
export function renderPipelineOutcome(lane: PipelineLane): string {
  const stage = lane.final_stage === null ? '' : ` · ${escapePipelineText(lane.final_stage)}`;
  switch (lane.outcome) {
    case 'go':
      return '<span class="badge badge-go">go</span>';
    case 'no_go':
      return '<span class="badge badge-no_go">no go</span>';
    case 'stopped':
      return `<span class="badge badge-no_go">stopped${stage}</span>`;
    case 'quorum_skip':
      return '<span class="badge badge-neutral">quorum skip</span>';
    case 'in_flight':
      return '<span class="badge badge-live">live</span>';
    default:
      return '<span class="pl-idle">no tick in window</span>';
  }
}

/**
 * One chip — a ticker, wherever it currently sits.
 *
 * Always a real `<button type="button">`: unlike a lane cell, every chip has a
 * drawer behind it, so there is no inert variant to guard against. The class
 * modifier is the outcome word itself rather than a hand-mapped colour, so a
 * new outcome added to the contract shows up as unstyled rather than silently
 * inheriting the wrong meaning.
 */
export function renderPipelineChip(
  lane: PipelineLane,
  options: PipelineRenderOptions,
  liveElapsedMs: number | null,
): string {
  const name = escapePipelineText(lane.instrument);
  const station = pipelineStationFor(lane);
  const settled = pipelineLaneChanged(lane.instrument, options.changedCells) ? ' pl-settle' : '';
  const selected = options.selectedInstrument === lane.instrument ? ' pl-selected' : '';

  let reading = '·';
  if (lane.outcome === 'in_flight') {
    reading = liveElapsedMs === null ? 'live' : formatStageDuration(liveElapsedMs);
  } else if (lane.total_ms !== null) {
    reading = formatStageDuration(lane.total_ms);
  }

  const stationLabel = station === null ? 'no tick in window' : PIPELINE_STAGE_LABELS[station];
  const label = `${lane.instrument} · ${stationLabel} · ${lane.outcome.replace('_', ' ')}`;
  return (
    `<button type="button" class="pl-chip pl-chip-${lane.outcome}${settled}${selected}"` +
    ` data-instrument="${name}" data-stage="${station === null ? '' : station}"` +
    ` aria-expanded="${selected === '' ? 'false' : 'true'}"` +
    ` title="${escapePipelineText(label)}" aria-label="${escapePipelineText(label)}">` +
    `<span class="pl-dot"></span><span class="pl-tick">${name}</span>` +
    `<span class="pl-el">${escapePipelineText(reading)}</span></button>`
  );
}

/**
 * One station: its heading, its load count, and the chips parked on it.
 *
 * An empty station renders a placeholder rather than collapsing — the seven
 * stations are the fixed frame of the view, and a rail that changed width as
 * ticks moved would be unreadable at a glance.
 */
export function renderPipelineStation(
  stage: PipelineStage,
  lanes: readonly PipelineLane[],
  options: PipelineRenderOptions,
  liveElapsedByInstrument: Record<string, number | null>,
  invalidationSeen: boolean,
): string {
  const chips = lanes
    .map((lane) =>
      renderPipelineChip(lane, options, liveElapsedByInstrument[lane.instrument] ?? null),
    )
    .join('');
  const hot = lanes.some((lane) => lane.outcome === 'in_flight') ? ' pl-hot' : '';
  const reserved =
    PIPELINE_RESERVED_STAGES.indexOf(stage) !== -1
      ? '<span class="pl-lock" title="no decision record is persisted for this stage yet — see #328">◇ no record</span>'
      : '';
  // The Invalidation caveat is asserted from the data, not hardcoded: the day
  // the stage ships and a ticker reaches it, the tooltip stops claiming it
  // never runs. A fixed string would have gone stale silently.
  const unbuilt =
    stage === 'invalidation' && !invalidationSeen
      ? ' title="specced, not built — never reached today"'
      : '';
  const body = chips === '' ? '<div class="pl-none">—</div>' : chips;
  return (
    `<div class="pl-station${hot}" data-stage="${stage}">` +
    `<div class="pl-station-head"${unbuilt}>${PIPELINE_STAGE_LABELS[stage]}` +
    `<span class="pl-n">${lanes.length}</span>${reserved}</div>` +
    `<div class="pl-bar"></div><div class="pl-chips">${body}</div></div>`
  );
}

/**
 * The gutter under the rail: what settled, most recent first, plus whatever
 * never ticked at all.
 *
 * Settled tickers appear **twice** — once parked on the station they stopped
 * at, once here. That is deliberate and is what the chosen prototype showed:
 * the station tells you *where* ticks are dying, the gutter tells you *what*
 * has happened lately. Collapsing them into one place loses one question or
 * the other.
 */
export function renderPipelineGutter(
  settled: readonly PipelineLane[],
  idle: readonly PipelineLane[],
  options: PipelineRenderOptions,
): string {
  const groups: string[] = [];
  if (settled.length > 0) {
    const chips = settled.map((lane) => renderPipelineChip(lane, options, null)).join('');
    groups.push(`<div class="pl-group"><span class="pl-lbl">settled</span>${chips}</div>`);
  }
  if (idle.length > 0) {
    const chips = idle.map((lane) => renderPipelineChip(lane, options, null)).join('');
    groups.push(
      `<div class="pl-group pl-group-idle"><span class="pl-lbl" title="in the universe, but no trace in this window">idle</span>${chips}</div>`,
    );
  }
  if (groups.length === 0) return '';
  return `<div class="pl-gutter">${groups.join('')}</div>`;
}

/**
 * The rail.
 *
 * The live chip's elapsed reading is computed once here, from
 * `live_entered_at` against the poll's clock, and it advances only when a poll
 * lands — the view's clock is the poll, not the wall clock, and a counter that
 * ran between polls would claim knowledge of a stage that may already have
 * ended (#421).
 *
 * Motion, restated for this primitive (#421's decision stands, its rendering
 * does not transfer verbatim): **nothing travels.** A chip that moved station
 * disappears from the old one and appears at the new one already settled, with
 * the one-shot ring. There is no transit animation between stations, because
 * the poll never observed the transit — it observed two positions 3s apart.
 */
export function renderPipelineRail(view: PipelineView, options: PipelineRenderOptions): string {
  if (view.lanes.length === 0) {
    return '<div class="pl-empty">No instrument has ticked in this window.</div>';
  }

  let invalidationSeen = false;
  for (const lane of view.lanes) {
    const cell = findPipelineCell(lane, 'invalidation');
    if (cell !== null && cell.state !== 'not_reached') invalidationSeen = true;
  }

  let liveElapsedMs: number | null = null;
  if (view.live_entered_at !== null) {
    const entered = Date.parse(view.live_entered_at);
    if (!Number.isNaN(entered) && options.nowMs >= entered) liveElapsedMs = options.nowMs - entered;
  }
  // The elapsed reading belongs to ONE trace — `live_entered_at` is singular.
  // If a second ticker ever reports an in-flight chip, handing it this figure
  // would print another instrument's stage duration as if it were measured. It
  // gets the bare live marker instead.
  const liveElapsedByInstrument: Record<string, number | null> = {};
  for (const lane of view.lanes) {
    liveElapsedByInstrument[lane.instrument] =
      lane.trace_id !== null && lane.trace_id === view.live_trace_id ? liveElapsedMs : null;
  }

  // Each ticker is placed exactly once, then the stations read back what
  // landed on them. Grouping this way rather than into a keyed object keeps
  // the serialised source free of index-signature guards it does not need.
  const idle: PipelineLane[] = [];
  const settled: PipelineLane[] = [];
  const placed: { lane: PipelineLane; station: PipelineStage }[] = [];
  for (const lane of view.lanes) {
    const station = pipelineStationFor(lane);
    if (station === null) {
      idle.push(lane);
      continue;
    }
    placed.push({ lane, station });
    if (lane.outcome !== 'in_flight') settled.push(lane);
  }

  const stations = PIPELINE_STAGE_ORDER.map((stage) =>
    renderPipelineStation(
      stage,
      placed.filter((p) => p.station === stage).map((p) => p.lane),
      options,
      liveElapsedByInstrument,
      invalidationSeen,
    ),
  ).join('');

  return `<div class="pl-rail">${stations}</div>${renderPipelineGutter(settled, idle, options)}`;
}

/**
 * The completed debate that belongs to this ticker's trace — best effort.
 *
 * **This join is necessary, not sufficient.** `DebateRow` carries `debate_id`
 * and `instrument` but no `trace_id`, so a trace cannot be joined to its own
 * debate exactly. The match is by instrument, narrowed to debates that closed
 * at or after the trace started; a second tick on the same instrument within
 * the same window can still select the wrong row. The drawer says so on the
 * panel rather than presenting the match as certain.
 */
export function selectDebateForLane(
  lane: PipelineLane,
  debates: readonly PipelineDebateSummary[],
): PipelineDebateSummary | null {
  if (lane.started_at === null) return null;
  const startedAt = Date.parse(lane.started_at);
  if (Number.isNaN(startedAt)) return null;
  let best: PipelineDebateSummary | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const debate of debates) {
    if (debate.instrument !== lane.instrument) continue;
    const at = Date.parse(debate.created_at);
    if (Number.isNaN(at) || at < startedAt) continue;
    if (at > bestAt) {
      best = debate;
      bestAt = at;
    }
  }
  return best;
}

/**
 * The Debate drill-down (#415).
 *
 * The live/completed asymmetry is the content, not a defect to smooth over: a
 * completed debate has per-analyst detail from `debate_log.contributions_json`,
 * an in-flight one has nothing at all because round-by-round state is not
 * persisted (Debate Engine decision #10). Rendered as a stated reason rather
 * than as a spinner or a skeleton — both of those promise detail that is not
 * coming.
 */
export function renderDebateSection(
  lane: PipelineLane,
  debates: readonly PipelineDebateSummary[],
): string {
  const cell = findPipelineCell(lane, 'debate');
  const state = cell === null ? 'not_reached' : cell.state;

  if (state === 'live') {
    return (
      '<h3>Debate</h3><div class="pl-note"><b>Nothing is recorded while a debate runs.</b>' +
      '<span class="pl-why">Round-by-round state is not persisted (Debate Engine decision #10). ' +
      'The chip is lit because <code>current_tick</code> says so; the per-analyst detail appears ' +
      'once the debate closes and writes <code>debate_log</code>.</span></div>'
    );
  }
  if (state === 'not_reached') {
    return '<h3>Debate</h3><div class="pl-note">Not reached — the tick ended earlier.</div>';
  }
  if (state === 'skipped') {
    return '<h3>Debate</h3><div class="pl-note">Skipped for this tick.</div>';
  }

  const debate = selectDebateForLane(lane, debates);
  if (debate === null) {
    return (
      '<h3>Debate</h3><div class="pl-note"><b>No completed debate row matches this trace.</b>' +
      '<span class="pl-why">Either the row has aged out of the snapshot window, or the debate ' +
      'stage ended without writing one.</span></div>'
    );
  }

  const cards = debate.contributions
    .map(
      (c) =>
        `<div class="pl-agent"><div class="pl-who">${escapePipelineText(c.analyst_id)}` +
        `<span class="badge badge-${escapePipelineText(c.final_position)}">${escapePipelineText(c.final_position.slice(0, 4))}</span></div>` +
        `<div class="pl-role">${escapePipelineText(c.analyst_type)}</div>` +
        `<div class="pl-inf">influence ${c.influence_score.toFixed(2)}</div>` +
        `<div class="pl-bar-inf"><i style="width:${Math.max(0, Math.min(100, Math.round(c.influence_score * 100)))}%"></i></div></div>`,
    )
    .join('');

  const empty =
    debate.contributions.length === 0
      ? '<div class="pl-note">No contributions recorded.</div>'
      : '';
  return (
    `<h3>Debate <span class="pl-sub">${escapePipelineText(debate.direction)} · ${debate.rounds} round(s)</span></h3>` +
    `<div class="pl-agents">${cards}</div>${empty}` +
    '<p class="pl-foot">Source: <code>debate_log.contributions_json</code>. Matched on instrument and ' +
    'start time — <code>DebateRow</code> carries no <code>trace_id</code>, so this is the most recent ' +
    'debate that closed after this trace began, not a proven join. Analyst weights are not repeated ' +
    'here; the Overview tab&rsquo;s Analyst Performance panel owns them.</p>'
  );
}

/** The Tier-2 empty slot: what a stage would show if it recorded anything. */
export function renderReservedSlot(lane: PipelineLane): string {
  // Reached only. A skipped stage did not run, so naming it here would promise
  // a record that was never going to exist even once #328 lands.
  const reached = PIPELINE_RESERVED_STAGES.filter((stage) => {
    const cell = findPipelineCell(lane, stage);
    return cell !== null && cell.state !== 'not_reached' && cell.state !== 'skipped';
  });
  if (reached.length === 0) return '';
  const names = reached.map((s) => PIPELINE_STAGE_LABELS[s]).join(', ');
  return (
    `<h3>${escapePipelineText(names)}</h3><div class="pl-note pl-reserved"><b>Reserved slot — nothing is persisted yet.</b>` +
    '<span class="pl-why">No trader / invalidation / risk record table exists; <code>audit_log</code> holds ' +
    'a digest only, which proves the stage ran and cannot reconstruct what it decided. The payload is ' +
    'owned by the decision-record map (#328); this is where it lands.</span></div>'
  );
}

/**
 * Per-stage state, timing and decision word for one ticker.
 *
 * **Under the stage rail this is the only place the per-stage record exists.**
 * A chip is one point on the rail, so a stage the tick *skipped* (#414's
 * three-way distinction) and a stage it reached more than once (`attempts`)
 * cannot be shown out there at all. Both are shown here, for every stage,
 * including the ones never reached — which is why the strip lists all seven
 * rather than only the interesting ones.
 */
export function renderStageStrip(lane: PipelineLane): string {
  const rows = PIPELINE_STAGE_ORDER.map((stage) => {
    const cell = findPipelineCell(lane, stage);
    const state = cell === null ? 'not_reached' : cell.state;
    const decision =
      cell !== null && cell.decision !== null ? escapePipelineText(cell.decision) : '—';
    const attempts =
      cell !== null && cell.attempts > 1
        ? ` <span class="pl-retry-flat" title="reached ${cell.attempts} times">×${cell.attempts}</span>`
        : '';
    return (
      `<tr><td>${PIPELINE_STAGE_LABELS[stage]}</td>` +
      `<td><span class="pl-state pl-${state}">${state.replace('_', ' ')}</span>${attempts}</td>` +
      `<td class="mono">${formatStageDuration(cell === null ? null : cell.duration_ms)}</td>` +
      `<td class="mono pl-decision">${decision}</td></tr>`
    );
  }).join('');
  return `<table class="pl-strip"><thead><tr><th>Stage</th><th>State</th><th>Duration</th><th>Decision</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * The drawer (#422).
 *
 * Under a rail the drawer carries more weight than it would under lanes: the
 * rail says only where a ticker is, so "what happened at each stage" is
 * entirely the strip's job. It follows the **current** trace — the one the
 * chip holds — and not the instrument's history: history is `audit_log`
 * grouped by `trace_id`, a different query and a different payload, and the
 * Verdict History table on the Overview tab already gives a chronological
 * per-trace record.
 */
export function renderPipelineDrawer(
  lane: PipelineLane | null,
  debates: readonly PipelineDebateSummary[],
): string {
  if (lane === null) {
    return '<div class="pl-drawer pl-drawer-empty">Select a ticker to see its stage detail. Read-only — nothing here acts on a trade.</div>';
  }
  if (lane.trace_id === null) {
    return (
      `<div class="pl-drawer"><div class="pl-drawer-head"><b>${escapePipelineText(lane.instrument)}</b>` +
      `<button type="button" class="pl-close" data-close="1">close</button></div>` +
      '<div class="pl-note">No trace in this window — the market is closed for this instrument, or it has not ticked yet.</div></div>'
    );
  }
  const meta = [
    `<span class="mono">${escapePipelineText(lane.trace_id)}</span>`,
    renderPipelineOutcome(lane),
    lane.total_ms === null
      ? ''
      : `<span class="pl-sub">${formatStageDuration(lane.total_ms)} total</span>`,
    lane.started_at === null
      ? ''
      : `<span class="pl-sub mono">${escapePipelineText(lane.started_at)}</span>`,
  ]
    .filter((s) => s !== '')
    .join('');
  return (
    `<div class="pl-drawer"><div class="pl-drawer-head"><b>${escapePipelineText(lane.instrument)}</b>${meta}` +
    '<button type="button" class="pl-close" data-close="1">close</button></div>' +
    `${renderStageStrip(lane)}${renderDebateSection(lane, debates)}${renderReservedSlot(lane)}` +
    '<p class="pl-foot">This is the ticker&rsquo;s current trace, not its history.</p></div>'
  );
}

/**
 * The functions above, as browser-ready source for `html.ts` to inline.
 *
 * Order matters only for the constants (hoisting covers the function
 * declarations). `pipeline-view.test.ts` evaluates this string and re-runs the
 * fixtures through it, so a function added here but not to the list is a test
 * failure rather than a page that silently stops rendering.
 */
export const PIPELINE_VIEW_CLIENT_SOURCE: string = [
  `const PIPELINE_STAGE_ORDER = ${JSON.stringify(PIPELINE_STAGES)};`,
  `const PIPELINE_STAGE_LABELS = ${JSON.stringify(PIPELINE_STAGE_LABELS)};`,
  `const PIPELINE_RESERVED_STAGES = ${JSON.stringify(PIPELINE_RESERVED_STAGES)};`,
  escapePipelineText.toString(),
  formatStageDuration.toString(),
  pipelineCellKey.toString(),
  findPipelineCell.toString(),
  findPipelineLane.toString(),
  diffPipelineCells.toString(),
  pipelineLaneChanged.toString(),
  pipelineStationFor.toString(),
  renderPipelineOutcome.toString(),
  renderPipelineChip.toString(),
  renderPipelineStation.toString(),
  renderPipelineGutter.toString(),
  renderPipelineRail.toString(),
  selectDebateForLane.toString(),
  renderDebateSection.toString(),
  renderReservedSlot.toString(),
  renderStageStrip.toString(),
  renderPipelineDrawer.toString(),
].join('\n');
