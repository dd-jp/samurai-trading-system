import type {
  DashboardSnapshot,
  PipelineCell,
  PipelineLane,
  PipelineStage,
  VerdictRow,
} from '../../contracts/index.ts';

const STAGE_GAP_MS = 20_000;

const SETTLED_STAGES: readonly { stage: PipelineStage; decision: string | null }[] = [
  { stage: 'analysts', decision: 'quorum_met' },
  { stage: 'debate', decision: 'bullish' },
  { stage: 'trader', decision: 'entry' },
  { stage: 'risk', decision: 'approved' },
  { stage: 'verdict', decision: null },
  { stage: 'execution', decision: 'filled' },
];

const SKIPPED_STAGE: PipelineStage = 'verdict';

export function laneOf(snapshot: DashboardSnapshot, instrument: string): PipelineLane {
  const lane = snapshot.pipeline.lanes.find((candidate) => candidate.instrument === instrument);
  if (lane === undefined) throw new Error(`no fixture lane for "${instrument}"`);
  return lane;
}

export function settleAtExecution(
  snapshot: DashboardSnapshot,
  instrument: string,
): DashboardSnapshot {
  const lane = laneOf(snapshot, instrument);
  const startedMs = Date.parse(lane.started_at ?? snapshot.as_of);

  let recorded = 0;
  const cells = SETTLED_STAGES.map<PipelineCell>(({ stage, decision }) => {
    if (stage === SKIPPED_STAGE) {
      return {
        stage,
        state: 'skipped',
        duration_ms: null,
        decision: null,
        recorded_at: null,
        attempts: 0,
      };
    }
    const recorded_at = new Date(startedMs + recorded * STAGE_GAP_MS).toISOString();
    recorded += 1;
    return { stage, state: 'done', duration_ms: 4_000, decision, recorded_at, attempts: 1 };
  });

  const settled: PipelineLane = {
    ...lane,
    cells,
    outcome: 'go',
    final_stage: 'execution',
    started_at: new Date(startedMs).toISOString(),
    total_ms: (recorded - 1) * STAGE_GAP_MS,
  };

  return {
    ...snapshot,
    tick_status: null,
    pipeline: {
      lanes: snapshot.pipeline.lanes.map((candidate) =>
        candidate.instrument === instrument ? settled : candidate,
      ),
      live_trace_id: null,
      live_entered_at: null,
    },
  };
}

export function withVerdict(snapshot: DashboardSnapshot, verdict: VerdictRow): DashboardSnapshot {
  return { ...snapshot, verdicts: [verdict, ...snapshot.verdicts] };
}
