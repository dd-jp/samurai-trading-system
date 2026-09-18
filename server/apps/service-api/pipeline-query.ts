import {
  isQuorumSkipDecision,
  PIPELINE_STAGES,
  type PipelineCell,
  type PipelineCellState,
  type PipelineLane,
  type PipelineOutcome,
  type PipelineStage,
  type PipelineView,
} from '../../../contracts/index.js';
import type { TickStage } from '../orchestrator/index.js';
import type { PipelineActivity, PipelineLiveTick, PipelineStageEvent } from './types.js';

export const PIPELINE_LOOKBACK_MS = 15 * 60 * 1_000;

export const PIPELINE_MAX_LANES = 24;

type _PipelineStagesAreWritable = PipelineStage extends TickStage ? true : never;
const _pipelineStagesAreWritable: _PipelineStagesAreWritable = true;
void _pipelineStagesAreWritable;

const LAST_STAGE = PIPELINE_STAGES[PIPELINE_STAGES.length - 1];

interface LaneTrace {
  trace_id: string;
  instrument: string;
  events: PipelineStageEvent[];
  live: PipelineLiveTick | null;
  last_activity_ms: number;
}

export function buildPipelineView(activity: PipelineActivity): PipelineView {
  const chosen = chooseTracePerInstrument(activity);

  const lanes = [...activity.universe]
    .sort(byAssetClassThenInstrument)
    .map<PipelineLane>((entry) => buildLane(entry.instrument, entry.asset_class, chosen));

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
  const durationByStage = new Map<PipelineStage, number>();
  const attemptsByStage = new Map<PipelineStage, number>();
  const decisionByStage = new Map<PipelineStage, string>();
  const recordedAtByStage = new Map<PipelineStage, Date>();
  let total_ms = 0;

  events.forEach((event, index) => {
    attemptsByStage.set(event.stage, (attemptsByStage.get(event.stage) ?? 0) + 1);
    decisionByStage.set(event.stage, event.decision);
    recordedAtByStage.set(event.stage, event.timestamp);
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
      duration_ms: state === 'live' ? null : (durationByStage.get(stage) ?? null),
      decision: decisionByStage.get(stage) ?? null,
      recorded_at: state === 'live' ? null : (recordedAtByStage.get(stage)?.toISOString() ?? null),
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
    started_at: (events[0]?.timestamp ?? live?.entered_at)?.toISOString() ?? null,
    total_ms,
  };
}

function idleCell(stage: PipelineStage): PipelineCell {
  return {
    stage,
    state: 'not_reached',
    duration_ms: null,
    decision: null,
    recorded_at: null,
    attempts: 0,
  };
}

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
    return live === null && stage === finalStage && stage !== LAST_STAGE ? 'stopped' : 'done';
  }
  return index < reachedIndex ? 'skipped' : 'not_reached';
}

function outcomeOf(trace: LaneTrace): PipelineOutcome {
  if (trace.live !== null) {
    return 'in_flight';
  }
  const last = trace.events[trace.events.length - 1];
  if (last === undefined) {
    return 'stopped';
  }
  if (last.stage === 'analysts' && isQuorumSkipDecision(last.decision)) {
    return 'quorum_skip';
  }
  if (last.stage === LAST_STAGE) {
    return 'go';
  }
  if (last.stage === 'verdict' && last.decision === 'no_go') {
    return 'no_go';
  }
  return 'stopped';
}
