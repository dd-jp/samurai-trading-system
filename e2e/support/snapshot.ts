/**
 * Typed transforms over a REAL `/api/snapshot` payload — the fixture material
 * for every multi-poll scenario (#544).
 *
 * Nothing here builds a snapshot from scratch, deliberately. `toWireSnapshot`
 * (useSnapshot.ts) validates the body's shape and, when it fails, DISCARDS the
 * payload while keeping the last good one — so a hand-written fixture that
 * drifted from the wire model does not fail loudly, it renders a page that
 * quietly goes stale. Starting from what the server actually served means the
 * only thing a transform can get wrong is the part the scenario is about.
 *
 * Imports are type-only, which is what lets Playwright load this module
 * straight from source: the type imports are erased before its loader ever has
 * to resolve them.
 */
import type {
  DashboardSnapshot,
  PipelineCell,
  PipelineLane,
  PipelineStage,
  VerdictRow,
} from '../../contracts/index.ts';

/** Recorded gap between the settled stages below — arbitrary but deterministic */
const STAGE_GAP_MS = 20_000;

/**
 * The settled trace this suite replays: recorded rows for five of the six
 * stages, and NONE for `SKIPPED_STAGE`, so the drawer's timeline has a
 * `skipped` row to render alongside the done ones
 */
const SETTLED_STAGES: readonly { stage: PipelineStage; decision: string | null }[] = [
  { stage: 'analysts', decision: 'quorum_met' },
  { stage: 'debate', decision: 'bullish' },
  { stage: 'trader', decision: 'entry' },
  { stage: 'risk', decision: 'approved' },
  { stage: 'verdict', decision: null },
  { stage: 'execution', decision: 'filled' },
];

/** The stage left without a recorded row */
const SKIPPED_STAGE: PipelineStage = 'verdict';

export function laneOf(snapshot: DashboardSnapshot, instrument: string): PipelineLane {
  const lane = snapshot.pipeline.lanes.find((candidate) => candidate.instrument === instrument);
  if (lane === undefined) throw new Error(`no fixture lane for "${instrument}"`);
  return lane;
}

/**
 * The same lane, one poll later: its in-flight trace has finished, recorded a
 * row at every stage it visited, and settled `go` at Execution. The
 * `trace_id` is unchanged, so the verdict row the scenario adds joins to it.
 */
export function settleAtExecution(
  snapshot: DashboardSnapshot,
  instrument: string,
): DashboardSnapshot {
  const lane = laneOf(snapshot, instrument);
  const startedMs = Date.parse(lane.started_at ?? snapshot.as_of);

  let recorded = 0;
  const cells = SETTLED_STAGES.map<PipelineCell>(({ stage, decision }) => {
    if (stage === SKIPPED_STAGE) {
      // Synthetic: the real tick-runner records sequentially and Verdict
      // gates Execution, so the runtime can never reach Execution without a
      // Verdict row. The gap is fabricated purely so the timeline renders a
      // `skipped` row — the same shape a genuine mid-pipeline skip produces
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
    // The tick that was in flight is over: both readouts of it have to agree,
    // or the strip claims a live trace the theater no longer shows
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

/** The same snapshot with one more row in `verdicts[]` — the ledger's join target */
export function withVerdict(snapshot: DashboardSnapshot, verdict: VerdictRow): DashboardSnapshot {
  return { ...snapshot, verdicts: [verdict, ...snapshot.verdicts] };
}
