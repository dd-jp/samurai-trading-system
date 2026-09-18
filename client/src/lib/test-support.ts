import type {
  PipelineCell,
  PipelineCellState,
  PipelineLane,
  PipelineOutcome,
  PipelineStage,
  PipelineView,
} from '@contracts';

const STAGES: readonly PipelineStage[] = [
  'analysts',
  'debate',
  'trader',
  'risk',
  'verdict',
  'execution',
];

const T0 = Date.parse('2026-08-07T12:00:00.000Z');

export function at(ms: number): string {
  return new Date(T0 + ms).toISOString();
}

interface CellSpec {
  state: PipelineCellState;
  recorded_at?: string | null;
  duration_ms?: number | null;
  decision?: string | null;
  attempts?: number;
}

export interface LaneSpec {
  instrument: string;
  trace_id?: string | null;
  outcome?: PipelineOutcome;
  asset_class?: 'crypto' | 'stocks';
  cells?: Partial<Record<PipelineStage, CellSpec>>;
  final_stage?: PipelineStage | null;
  started_at?: string | null;
  total_ms?: number | null;
}

export function makeLane(spec: LaneSpec): PipelineLane {
  const cells: PipelineCell[] = STAGES.map((stage) => {
    const cell = spec.cells?.[stage];
    return {
      stage,
      state: cell?.state ?? 'not_reached',
      duration_ms: cell?.duration_ms ?? null,
      decision: cell?.decision ?? null,
      recorded_at: cell?.recorded_at ?? null,
      attempts: cell?.attempts ?? (cell ? 1 : 0),
    };
  });
  return {
    instrument: spec.instrument,
    asset_class: spec.asset_class ?? 'crypto',
    trace_id: spec.trace_id !== undefined ? spec.trace_id : null,
    cells,
    outcome: spec.outcome ?? 'idle',
    final_stage: spec.final_stage ?? null,
    started_at: spec.started_at ?? null,
    total_ms: spec.total_ms ?? null,
  };
}

export function makeView(
  lanes: PipelineLane[],
  live?: { live_trace_id: string | null; live_entered_at: string | null },
): PipelineView {
  return {
    lanes,
    live_trace_id: live?.live_trace_id ?? null,
    live_entered_at: live?.live_entered_at ?? null,
  };
}

export function doneThrough(
  instrument: string,
  trace_id: string,
  upTo: PipelineStage,
  opts?: { startMs?: number; stepMs?: number; outcome?: PipelineOutcome },
): PipelineLane {
  const startMs = opts?.startMs ?? 0;
  const stepMs = opts?.stepMs ?? 1_000;
  const upToIdx = STAGES.indexOf(upTo);
  const cells: Partial<Record<PipelineStage, CellSpec>> = {};
  for (let i = 0; i <= upToIdx; i++) {
    const stage = STAGES[i];
    if (stage === undefined) break;
    cells[stage] = { state: 'done', recorded_at: at(startMs + (i + 1) * stepMs) };
  }
  return makeLane({
    instrument,
    trace_id,
    outcome: opts?.outcome ?? 'in_flight',
    cells,
    final_stage: upTo,
    started_at: at(startMs),
  });
}
