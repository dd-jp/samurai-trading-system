/**
 * `buildPipelineView` — the pure projection behind the dashboard's Pipeline
 * view (wayfinder map #411; ticker lanes decided in #412). Takes the raw
 * `PipelineActivity` a `DashboardQueryStore` read produces and turns it into
 * the frozen `PipelineView` wire model in `pipeline-types.ts`.
 *
 * Pure by design, the same seam `buildSnapshot` uses: every cell-state rule
 * below is exercised from an event list in `pipeline-query.test.ts` without a
 * database, which matters more here than elsewhere because two of the rules
 * (`skipped`, and a `stopped` before Verdict) describe traffic the current
 * schema cannot yet deliver. See "What a lane can and cannot see".
 *
 * ## What a lane can and cannot see  (read this before trusting a lane)
 *
 * `audit_log` carries no `instrument` column and `trace_id` is a bare
 * `randomUUID()`, so a stage row can only be attributed to an instrument by
 * joining a table that holds both. Today that is `current_tick` (in-flight
 * only) and `verdict_log` (only traces that actually reached Verdict). A tick
 * that short-circuits at Analysts, Trader or Risk writes its `audit_log` rows
 * and is then unattributable — invisible to this view.
 *
 * The consequence is deliberate and bounded rather than hidden:
 *
 *  - A lane shows the most recent trace it can SEE, never a claim about the
 *    most recent trace that RAN.
 *  - `PIPELINE_LOOKBACK_MS` is what keeps that honest. Past the window a lane
 *    goes `idle` — "nothing visible here recently" — instead of presenting an
 *    old trace as the current state of the instrument.
 *
 * The fix is one additive migration (`instrument`, `asset_class` on
 * `audit_log`; `tick-runner.ts`'s `record` closure already holds both) plus a
 * single-query change in `SqliteQueryStore.getPipelineActivity`. Nothing in
 * this file changes when it lands.
 */

import type { TickStage } from '../orchestrator/index.js';
import {
  PIPELINE_STAGES,
  type PipelineCell,
  type PipelineCellState,
  type PipelineLane,
  type PipelineOutcome,
  type PipelineStage,
  type PipelineView,
} from './pipeline-types.js';
import type { PipelineActivity, PipelineLiveTick, PipelineStageEvent } from './types.js';

/**
 * How far back a lane reaches (#413) — a time window, not a count of traces.
 *
 * A count would make a lane's depth depend on how busy the OTHER lanes were,
 * and "last 10 traces" across a 24/7 crypto instrument and a market-hours
 * equity means two entirely different reaches. Fifteen minutes is fifteen
 * ticks at `DEFAULT_TICK_INTERVAL_MS` (60s): long enough that a lane does not
 * blink empty between ticks or across a few missed ones, short enough that a
 * lane never presents a stale trace as the instrument's current state. It is
 * deliberately a hotter, shorter reach than the Verdict table's chronological
 * history, which remains the place to look further back.
 */
export const PIPELINE_LOOKBACK_MS = 15 * 60 * 1_000;

/**
 * Hard bound on lanes. The default universe is six instruments
 * (ADR-0001: SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD); this leaves room to grow
 * without letting a 3-second poll's payload grow with `latest_mark`.
 */
export const PIPELINE_MAX_LANES = 24;

/**
 * The stages the RUNTIME can currently write, as a value rather than a type.
 *
 * `Record<TickStage, true>` is load-bearing: the orchestrator's `TickStage`
 * union is the authority on which stages exist, and the day `invalidation`
 * joins it this object stops compiling until the key is added — at which point
 * `invalidation` gaps start reading as `skipped` on their own. Hard-coding the
 * not-yet-built stage instead would have left a lie that type-checks.
 */
const RUNTIME_STAGES: Record<TickStage, true> = {
  analysts: true,
  debate: true,
  trader: true,
  risk: true,
  verdict: true,
  execution: true,
};

const LAST_STAGE = PIPELINE_STAGES[PIPELINE_STAGES.length - 1];

/** One instrument's chosen trace: its stage rows, and its `current_tick` row if it has one. */
interface LaneTrace {
  trace_id: string;
  instrument: string;
  /** Ascending by timestamp; empty for a tick that has entered a stage but not yet recorded one. */
  events: PipelineStageEvent[];
  live: PipelineLiveTick | null;
  /** Most recent evidence of this trace, used only to pick between candidates. */
  last_activity_ms: number;
}

export function buildPipelineView(activity: PipelineActivity): PipelineView {
  const chosen = chooseTracePerInstrument(activity);

  const lanes = [...activity.universe]
    // Instrument-stable ordering (#413), decided here rather than left to the
    // store so the wire order holds for every `DashboardQueryStore`
    // implementation. Never newest-first: a lane that reshuffles on a
    // 3-second poll moves under the operator's pointer mid-read.
    .sort(byAssetClassThenInstrument)
    .map<PipelineLane>((entry) => buildLane(entry.instrument, entry.asset_class, chosen));

  // The single live pointer mirrors `getTickStatus`'s existing convention —
  // the most recently updated `current_tick` row. Several lanes can be
  // `in_flight` at once (`max_concurrent_instruments` > 1 is normal); this
  // names the newest of them for the view header, it does not bound them.
  const newestLive = activity.live.reduce<PipelineLiveTick | null>(
    (newest, tick) =>
      newest === null || tick.entered_at.getTime() > newest.entered_at.getTime() ? tick : newest,
    null,
  );

  return {
    lanes,
    live_trace_id: newestLive?.trace_id ?? null,
    live_entered_at: newestLive?.entered_at.toISOString() ?? null,
  };
}

function byAssetClassThenInstrument(
  a: { instrument: string; asset_class: string },
  b: { instrument: string; asset_class: string },
): number {
  return a.asset_class.localeCompare(b.asset_class) || a.instrument.localeCompare(b.instrument);
}

/**
 * One trace per lane: the most recently active one the store could attribute.
 *
 * A live trace does NOT win automatically. `current_tick` is deliberately left
 * stale by a crash mid-tick (tick-runner.ts's header — a stale row must be
 * visible, not tidied away), so pinning a lane to it would freeze that
 * instrument on a dead trace while newer ticks came and went. Comparing last
 * activity instead lets a settled trace overtake a stale live row, and costs
 * nothing in the normal case where the live row IS the newest thing.
 */
function chooseTracePerInstrument(activity: PipelineActivity): Map<string, LaneTrace> {
  const byTrace = new Map<string, LaneTrace>();

  for (const event of activity.events) {
    const existing = byTrace.get(event.trace_id);
    if (existing === undefined) {
      byTrace.set(event.trace_id, {
        trace_id: event.trace_id,
        instrument: event.instrument,
        events: [event],
        live: null,
        last_activity_ms: event.timestamp.getTime(),
      });
      continue;
    }
    existing.events.push(event);
    existing.last_activity_ms = Math.max(existing.last_activity_ms, event.timestamp.getTime());
  }

  for (const tick of activity.live) {
    const existing = byTrace.get(tick.trace_id);
    if (existing === undefined) {
      // A tick that has entered Analysts but not yet recorded it: the audit
      // row is written after the stage returns, so an in-flight lane's first
      // seconds have a `current_tick` row and no events at all.
      byTrace.set(tick.trace_id, {
        trace_id: tick.trace_id,
        instrument: tick.instrument,
        events: [],
        live: tick,
        last_activity_ms: tick.entered_at.getTime(),
      });
      continue;
    }
    existing.live = tick;
    existing.last_activity_ms = Math.max(existing.last_activity_ms, tick.entered_at.getTime());
  }

  const byInstrument = new Map<string, LaneTrace>();
  for (const trace of byTrace.values()) {
    // A stable timestamp sort keeps equal timestamps in the order the store
    // returned them, which is `rowid` order — the same tie-break
    // `SqliteAuditLog.getByTraceId` applies, and the reason it exists: a fixed
    // test clock puts several stages on the same ISO millisecond.
    trace.events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const incumbent = byInstrument.get(trace.instrument);
    if (incumbent === undefined || trace.last_activity_ms > incumbent.last_activity_ms) {
      byInstrument.set(trace.instrument, trace);
    }
  }
  return byInstrument;
}

function buildLane(
  instrument: string,
  asset_class: PipelineLane['asset_class'],
  chosen: Map<string, LaneTrace>,
): PipelineLane {
  const trace = chosen.get(instrument);
  if (trace === undefined) {
    // The idle lane (#413). An instrument with nothing visible in the window
    // still gets its row: dropping it would read as "removed from the
    // universe", and a closed market is the common, correct reason to be here.
    return {
      instrument,
      asset_class,
      trace_id: null,
      cells: PIPELINE_STAGES.map((stage) => idleCell(stage)),
      outcome: 'idle',
      final_stage: null,
      started_at: null,
      total_ms: null,
    };
  }

  const { events, live } = trace;
  // Each row's duration is the gap to the NEXT row of the same trace, so the
  // gaps partition the trace's whole span exactly once. The final row of a
  // settled trace has no successor and therefore no honest duration — the
  // stage's end was never recorded, and inventing one from `asOf` would report
  // a number that grows while the operator watches a finished tick.
  //
  // A gap of exactly 0 is kept as 0, not folded into `null`. The two mean
  // different things and the difference survives to the wire: `0` is a
  // measurement (two rows on the same millisecond — a stage that returned
  // inside the clock's resolution, and what a fixed test clock produces
  // throughout), `null` is the absence of one. Dropping zeroes would report
  // the fastest stages as unmeasured.
  const durationByStage = new Map<PipelineStage, number>();
  const attemptsByStage = new Map<PipelineStage, number>();
  const decisionByStage = new Map<PipelineStage, string>();
  let total_ms = 0;

  events.forEach((event, index) => {
    attemptsByStage.set(event.stage, (attemptsByStage.get(event.stage) ?? 0) + 1);
    // Last write wins: a retried stage's outcome is what it finally decided,
    // while `attempts` is what says the road there was bumpy (#414).
    decisionByStage.set(event.stage, event.decision);
    const next = events[index + 1];
    if (next === undefined) {
      return;
    }
    const gap = next.timestamp.getTime() - event.timestamp.getTime();
    durationByStage.set(event.stage, (durationByStage.get(event.stage) ?? 0) + gap);
    total_ms += gap;
  });

  const reachedIndex = Math.max(
    ...events.map((event) => PIPELINE_STAGES.indexOf(event.stage)),
    live === null ? -1 : PIPELINE_STAGES.indexOf(live.stage),
  );
  const finalStage = live?.stage ?? events[events.length - 1]?.stage ?? null;

  const cells = PIPELINE_STAGES.map<PipelineCell>((stage, index) => {
    const attempts = attemptsByStage.get(stage) ?? 0;
    const state = cellState({ stage, index, attempts, reachedIndex, live, finalStage });
    return {
      stage,
      state,
      // A live cell's clock is still running and belongs to the client
      // (`live_entered_at`); a skipped or never-reached cell has no wall time
      // to report at all.
      duration_ms: state === 'live' ? null : (durationByStage.get(stage) ?? null),
      decision: decisionByStage.get(stage) ?? null,
      attempts,
    };
  });

  return {
    instrument,
    asset_class,
    trace_id: trace.trace_id,
    cells,
    outcome: outcomeOf(trace),
    final_stage: finalStage,
    // `current_tick.updated_at` stands in when a live tick has recorded
    // nothing yet, so the lane still says when it began rather than reading as
    // a trace with no start.
    started_at: (events[0]?.timestamp ?? live?.entered_at)?.toISOString() ?? null,
    total_ms,
  };
}

function idleCell(stage: PipelineStage): PipelineCell {
  return { stage, state: 'not_reached', duration_ms: null, decision: null, attempts: 0 };
}

/**
 * The cell-state rules (#414), in one place so the four states cannot drift
 * apart across the two halves of the feature.
 */
function cellState(input: {
  stage: PipelineStage;
  index: number;
  attempts: number;
  reachedIndex: number;
  live: PipelineLiveTick | null;
  finalStage: PipelineStage | null;
}): PipelineCellState {
  const { stage, index, attempts, reachedIndex, live, finalStage } = input;

  if (live !== null && live.stage === stage) {
    return 'live';
  }
  if (attempts > 0) {
    // "Reached, and the tick ended here" — the cell that carries the reason a
    // short-circuited tick went no further. Execution is exempt: nothing
    // follows it, so a trace that got there ran the pipeline to its end.
    return live === null && stage === finalStage && stage !== LAST_STAGE ? 'stopped' : 'done';
  }
  if (!(stage in RUNTIME_STAGES)) {
    // Specced but not built (`invalidation`). A gap here is not a decision to
    // omit the stage — nothing can write it yet — so it must never read as
    // `skipped`, which would claim a choice the tick never made.
    return 'not_reached';
  }
  // No row, yet the trace carried on past this stage: a deliberate skip, which
  // is normal traffic and must not read as a halted pipeline.
  return index < reachedIndex ? 'skipped' : 'not_reached';
}

/**
 * How the trace ended. Keyed on the last row's `decision` word, because
 * `final_stage` alone records WHERE a tick stopped and never WHY (#414) — and
 * the distinctions here are exactly the ones an operator acts on differently.
 */
function outcomeOf(trace: LaneTrace): PipelineOutcome {
  if (trace.live !== null) {
    return 'in_flight';
  }
  const last = trace.events[trace.events.length - 1];
  if (last === undefined) {
    // Unreachable: a `LaneTrace` is created either from an event or from a
    // live tick, so no-events implies live, which returned above. `stopped`
    // rather than `idle` all the same — `idle` is the ONE outcome that comes
    // with a `null` trace_id (built by `buildLane`'s early return), and a lane
    // carrying a trace id while claiming to be idle would be a contradiction
    // on the wire rather than a harmless fallback.
    return 'stopped';
  }
  if (last.stage === 'analysts' && last.decision === 'quorum_skip') {
    // Normal quiet-market traffic, not a halt (analysts-spec.md story 21).
    return 'quorum_skip';
  }
  if (last.stage === LAST_STAGE) {
    // Execution only runs behind a `go`, so reaching it IS the go outcome.
    return 'go';
  }
  if (last.stage === 'verdict' && last.decision === 'no_go') {
    // A decided rejection: the tick traversed the whole pipeline and the
    // answer was no. Distinct from `stopped`, which is a tick that never got
    // the chance to be judged.
    return 'no_go';
  }
  return 'stopped';
}
