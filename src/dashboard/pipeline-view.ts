/**
 * Render layer for the dashboard's Pipeline view — ticker lanes, one row per
 * instrument, one column per stage (wayfinder map #411, primitive decided in
 * #412). Reads `PipelineView` from `pipeline-types.ts`; knows nothing about
 * where those shapes came from.
 *
 * **Why this file exists at all.** `html.ts` is one inlined template literal
 * with no build step, so nothing in it can be unit-tested — a rendering rule
 * written there is a rule nobody can assert on. The lanes carry real decisions
 * (a skipped stage must not read as a stopped one; a live debate must not read
 * as an empty one), so the rules live here as plain functions with tests, and
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

/** Column headings. Title case to match the existing table headers' density. */
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
 * payload is owned by the decision-record map #328).
 */
const PIPELINE_RESERVED_STAGES: PipelineStage[] = ['trader', 'invalidation', 'risk'];

/**
 * One completed debate, as the snapshot already carries it.
 *
 * Declared structurally rather than importing `DebateRow` from `types.ts`: that
 * file is owned by the query half of this feature and is being edited in
 * parallel. This is the subset the drawer actually reads, and TypeScript
 * checks it structurally at the call site in either case.
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

/** Everything the lane renderer needs that is not in `PipelineView` itself. */
export interface PipelineRenderOptions {
  /** The lane whose drawer is open, or `null`. Keyed by instrument — see `pipelineLaneSignature`. */
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

/** The diff key for one cell. Instrument-scoped, so lanes can reorder freely. */
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
 * flashing the whole table would signal change where there is only arrival.
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
 * Everything about a lane that, if unchanged, means the row can be left alone.
 *
 * Wholesale `innerHTML` replacement every 3s would drop keyboard focus out of
 * the table and restart every CSS transition on every cell, so `html.ts`
 * compares this signature and skips the DOM write when it matches. Deliberately
 * excludes the live elapsed reading, which advances on every poll by design.
 */
export function pipelineLaneSignature(lane: PipelineLane, isSelected: boolean): string {
  const cells = lane.cells
    .map((c) => `${c.stage}:${c.state}:${c.duration_ms ?? ''}:${c.attempts}:${c.decision ?? ''}`)
    .join(',');
  return `${lane.trace_id ?? '-'}|${lane.outcome}|${lane.total_ms ?? ''}|${isSelected}|${cells}`;
}

/** How a lane ended, as a badge. Reuses the existing `.badge-*` vocabulary. */
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
 * One cell.
 *
 * Interactive only where there is something to drill into — `done`, `live` and
 * `stopped`. A `skipped` or `not_reached` cell is a real `<div>`, not a dead
 * button: offering a keyboard stop that opens nothing is worse than not
 * offering one. Where it is interactive it is a real `<button type="button">`,
 * which is what buys the focus ring and Enter/Space for free.
 */
export function renderPipelineCell(
  lane: PipelineLane,
  stage: PipelineStage,
  options: PipelineRenderOptions,
  liveElapsedMs: number | null,
): string {
  const cell = findPipelineCell(lane, stage);
  const state = cell === null ? 'not_reached' : cell.state;
  const key = pipelineCellKey(lane.instrument, stage);
  const settled = options.changedCells.indexOf(key) !== -1 ? ' pl-settle' : '';
  const retry =
    cell !== null && cell.attempts > 1
      ? `<span class="pl-retry" title="reached ${cell.attempts} times">×${cell.attempts}</span>`
      : '';

  let text = '·';
  if (state === 'live') text = liveElapsedMs === null ? 'live' : formatStageDuration(liveElapsedMs);
  else if (state === 'skipped') text = 'skip';
  else if (cell !== null && cell.duration_ms !== null) text = formatStageDuration(cell.duration_ms);
  else if (state === 'done' || state === 'stopped') text = '✓';

  const label = `${lane.instrument} · ${PIPELINE_STAGE_LABELS[stage]} · ${state.replace('_', ' ')}${
    cell !== null && cell.decision !== null ? ` · ${cell.decision}` : ''
  }`;
  const body = `<span class="pl-seg pl-${state}${settled}">${escapePipelineText(text)}${retry}</span>`;

  if (state === 'done' || state === 'live' || state === 'stopped') {
    return (
      `<td class="pl-cell"><button type="button" class="pl-hit" data-instrument="${escapePipelineText(lane.instrument)}"` +
      ` data-stage="${stage}" title="${escapePipelineText(label)}" aria-label="${escapePipelineText(label)}">${body}</button></td>`
    );
  }
  return `<td class="pl-cell"><div class="pl-hit pl-inert" title="${escapePipelineText(label)}">${body}</div></td>`;
}

/** One lane: the instrument, its seven cells, its outcome. */
export function renderPipelineLane(
  lane: PipelineLane,
  options: PipelineRenderOptions,
  liveElapsedMs: number | null,
): string {
  const selected = options.selectedInstrument === lane.instrument;
  const cells = PIPELINE_STAGE_ORDER.map((stage) =>
    renderPipelineCell(lane, stage, options, liveElapsedMs),
  ).join('');
  const dormant = lane.outcome === 'idle' ? ' pl-dormant' : '';
  const name = escapePipelineText(lane.instrument);
  return (
    `<tr class="pl-lane${dormant}${selected ? ' pl-selected' : ''}" data-instrument="${name}"` +
    ` data-signature="${escapePipelineText(pipelineLaneSignature(lane, selected))}">` +
    `<td class="pl-name"><button type="button" class="pl-toggle" data-instrument="${name}"` +
    ` aria-expanded="${selected ? 'true' : 'false'}">${name}` +
    `<span class="pl-class">${escapePipelineText(lane.asset_class)}</span></button></td>` +
    cells +
    `<td class="pl-outcome">${renderPipelineOutcome(lane)}</td></tr>`
  );
}

/**
 * The lanes table.
 *
 * The live cell's elapsed reading is computed once here, from
 * `live_entered_at` against the poll's clock, and it advances only when a poll
 * lands — the view's clock is the poll, not the wall clock, and a counter that
 * ran between polls would claim knowledge of a stage that may already have
 * ended (#421).
 */
export function renderPipelineLanes(view: PipelineView, options: PipelineRenderOptions): string {
  // The Invalidation caveat is asserted from the data, not hardcoded: the day
  // the stage ships and a lane reaches it, the tooltip stops claiming it never
  // runs. A fixed string would have gone stale silently.
  let invalidationSeen = false;
  for (const lane of view.lanes) {
    const cell = findPipelineCell(lane, 'invalidation');
    if (cell !== null && cell.state !== 'not_reached') invalidationSeen = true;
  }
  const head =
    '<thead><tr><th class="pl-name">Instrument</th>' +
    PIPELINE_STAGE_ORDER.map(
      (s) =>
        `<th${s === 'invalidation' && !invalidationSeen ? ' title="specced, not built — never reached today"' : ''}>${PIPELINE_STAGE_LABELS[s]}</th>`,
    ).join('') +
    '<th class="pl-outcome">Outcome</th></tr></thead>';

  if (view.lanes.length === 0) {
    return `<table class="pl-lanes">${head}<tbody><tr><td class="pl-empty" colspan="${PIPELINE_STAGE_ORDER.length + 2}">No instrument has ticked in this window.</td></tr></tbody></table>`;
  }

  let liveElapsedMs: number | null = null;
  if (view.live_entered_at !== null) {
    const entered = Date.parse(view.live_entered_at);
    if (!Number.isNaN(entered) && options.nowMs >= entered) liveElapsedMs = options.nowMs - entered;
  }

  // The elapsed reading belongs to ONE trace — `live_entered_at` is singular.
  // If a second lane ever reports a `live` cell, handing it this figure would
  // print another instrument's stage duration as if it were measured. It gets
  // the bare live marker instead.
  const rows = view.lanes
    .map((lane) =>
      renderPipelineLane(
        lane,
        options,
        lane.trace_id !== null && lane.trace_id === view.live_trace_id ? liveElapsedMs : null,
      ),
    )
    .join('');
  return `<table class="pl-lanes">${head}<tbody>${rows}</tbody></table>`;
}

/**
 * The completed debate that belongs to this lane's trace — best effort.
 *
 * **This join is necessary, not sufficient.** `DebateRow` carries `debate_id`
 * and `instrument` but no `trace_id`, so a lane cannot be joined to its own
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
      'The cell is lit because <code>current_tick</code> says so; the per-analyst detail appears ' +
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
        `<div class="pl-bar"><i style="width:${Math.max(0, Math.min(100, Math.round(c.influence_score * 100)))}%"></i></div></div>`,
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

/** Per-stage decision words and timings — what the row itself has no room for. */
export function renderStageStrip(lane: PipelineLane): string {
  const rows = PIPELINE_STAGE_ORDER.map((stage) => {
    const cell = findPipelineCell(lane, stage);
    const state = cell === null ? 'not_reached' : cell.state;
    const decision =
      cell !== null && cell.decision !== null ? escapePipelineText(cell.decision) : '—';
    const attempts =
      cell !== null && cell.attempts > 1
        ? ` <span class="pl-retry-flat">×${cell.attempts}</span>`
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
 * Under lanes, "where is this ticker" is already the row, so the drawer is only
 * what the row cannot hold: the decision word per stage, the trace id, the
 * retry count, and the Debate detail. It follows the **current** trace — the
 * one the lane holds — and not the instrument's history: history is
 * `audit_log` grouped by `trace_id`, a different query and a different payload,
 * and the Verdict History table on the Overview tab already gives a
 * chronological per-trace record.
 */
export function renderPipelineDrawer(
  lane: PipelineLane | null,
  debates: readonly PipelineDebateSummary[],
): string {
  if (lane === null) {
    return '<div class="pl-drawer pl-drawer-empty">Select a lane to see its stage detail. Read-only — nothing here acts on a trade.</div>';
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
  pipelineLaneSignature.toString(),
  renderPipelineOutcome.toString(),
  renderPipelineCell.toString(),
  renderPipelineLane.toString(),
  renderPipelineLanes.toString(),
  selectDebateForLane.toString(),
  renderDebateSection.toString(),
  renderReservedSlot.toString(),
  renderStageStrip.toString(),
  renderPipelineDrawer.toString(),
].join('\n');
