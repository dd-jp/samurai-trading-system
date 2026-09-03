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

/**
 * Recorded gap between the settled stages below.
 *
 * Chosen so the replay is deterministic rather than timing-lucky: every gap
 * exceeds `HOP_MAX_MS` (450ms), so all three hops clamp to the ceiling
 * (1350ms unclamped), which then scales down to the 1200ms `WALK_BUDGET_MS`
 * as 400ms per hop with nothing pinned at the floor. A ~1.2s walk, sampled at
 * `motion.ts`'s `SAMPLE_INTERVAL_MS`, is dozens of intermediate positions.
 */
export const STAGE_GAP_MS = 20_000;

/**
 * The settled trace this suite replays: recorded rows for five of the six
 * stages, and NONE for `SKIPPED_ROOM`.
 *
 * The gap is the point: Motion rule 6 says a stage with no recorded
 * transition is never entered, so the chip must hop trader → risk → execution
 * straight over the skipped room. `SKIPPED_ROOM` is an otherwise-arbitrary
 * mid-path stage chosen only to exercise that rule — a fixture that recorded
 * all six stages could not tell a compliant walk from a walk that visits
 * every room it passes.
 */
const SETTLED_STAGES: readonly { stage: PipelineStage; decision: string | null }[] = [
  { stage: 'analysts', decision: 'quorum_met' },
  { stage: 'debate', decision: 'bullish' },
  { stage: 'trader', decision: 'entry' },
  { stage: 'risk', decision: 'approved' },
  { stage: 'verdict', decision: null },
  { stage: 'execution', decision: 'filled' },
];

/** The rooms a chip must step through for `settleAtExecution`, in order. */
export const WALKED_ROOMS: readonly PipelineStage[] = ['trader', 'risk', 'execution'];

/** The room the walk must never enter — no recorded transition exists for it. */
export const SKIPPED_ROOM: PipelineStage = 'verdict';

export function laneOf(snapshot: DashboardSnapshot, instrument: string): PipelineLane {
  const lane = snapshot.pipeline.lanes.find((candidate) => candidate.instrument === instrument);
  if (lane === undefined) throw new Error(`no fixture lane for "${instrument}"`);
  return lane;
}

/**
 * The same lane, one poll later: its in-flight trace has finished, recorded a
 * row at every stage it visited, and settled `go` at Execution.
 *
 * The `trace_id` is deliberately UNCHANGED. A rotated trace takes
 * `computeWalkPlan`'s rule-7 branch and walks from Analysts instead, which is
 * a different hop list than the one these scenarios assert.
 */
export function settleAtExecution(
  snapshot: DashboardSnapshot,
  instrument: string,
): DashboardSnapshot {
  const lane = laneOf(snapshot, instrument);
  const startedMs = Date.parse(lane.started_at ?? snapshot.as_of);

  let recorded = 0;
  const cells = SETTLED_STAGES.map<PipelineCell>(({ stage, decision }) => {
    if (stage === SKIPPED_ROOM) {
      return {
        stage,
        state: 'not_reached',
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
    // or the strip claims a live trace the theater no longer shows.
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

/** The same snapshot with one more row in `verdicts[]` — the ledger's join target. */
export function withVerdict(snapshot: DashboardSnapshot, verdict: VerdictRow): DashboardSnapshot {
  return { ...snapshot, verdicts: [verdict, ...snapshot.verdicts] };
}
