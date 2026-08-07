/**
 * Replay motion planner for the pipeline theater (issue #537; the Motion
 * section of dashboard-spec.md, ADR-0011). Pure function of two snapshots —
 * no React, no DOM, no wall clock: every timestamp it reads was recorded by
 * the store, so the plan is a retelling of rows that exist, never an
 * interpolation between two observations.
 *
 * Rule map (spec "Motion — replay only"):
 *  1. only recorded transitions animate      → hops built from `recorded_at`
 *     rows plus, for a live destination, `live_entered_at` (`current_tick`);
 *  2. proportional durations, clamped        → `allocateHopDurations`;
 *  3. first paint places without walking     → `opts.firstPaint` snaps;
 *  4/5. hidden tab / reduced motion snap     → `opts.snapOnly` snaps;
 *  6. skipped stages are never walked        → null-`recorded_at` cells are
 *     hopped over, not entered;
 *  7. a rotated trace returns to Analysts    → `trace_id` change replans the
 *     walk from room 01 through the new trace's recorded stages;
 *  8. aging to idle snaps to the Lobby       → a null `trace_id` after a
 *     non-null one is a snap, not a walk and not a departure;
 *  9. a new poll mid-walk wins               → the renderer's concern: it
 *     discards the outstanding plan when the next one arrives.
 */

import type {
  PipelineLane,
  PipelineStage,
  PipelineView,
} from '../../../dashboard/pipeline-types.ts';
import { type RoomId, roomFor, roomIndex, stageAt } from './room-layout.ts';

/** Per-hop duration floor — a hop shorter than this reads as a teleport. */
export const HOP_MIN_MS = 150;
/** Per-hop duration ceiling — the replay is time-compressed, never literal. */
export const HOP_MAX_MS = 450;
/**
 * Whole-walk budget per chip per poll. Chips walk in parallel, so this bounds
 * when the replay finishes: always before the next 3-second poll. The floor
 * is always satisfiable inside it — the longest possible walk is 7 hops
 * (Lobby/rotation through all seven rooms), and 7 x 150 = 1050 <= 1200.
 */
export const WALK_BUDGET_MS = 1_200;

export interface WalkHop {
  room: RoomId;
  duration_ms: number;
}

export type ChipMotion =
  /** Place without animating: first paint, snapOnly, aged-to-idle, or an unwalkable change. */
  | { kind: 'snap'; instrument: string; room: RoomId }
  /** Lane not present in the previous snapshot — fade in, already placed. */
  | { kind: 'appear'; instrument: string; room: RoomId }
  /** Lane gone from this snapshot — fade out from where it stood. */
  | { kind: 'depart'; instrument: string; room: RoomId }
  /** Recorded transitions to replay, in order, from `from` through each hop's room. */
  | { kind: 'walk'; instrument: string; from: RoomId; hops: WalkHop[]; total_ms: number };

export interface WalkPlan {
  motions: ChipMotion[];
  /** When the whole replay is over: the longest single chip walk (chips animate in parallel). */
  total_ms: number;
}

export interface WalkPlanOptions {
  /** No previous snapshot was rendered — chips appear where they are (Motion rule 3). */
  firstPaint: boolean;
  /** Hidden-tab return or `prefers-reduced-motion` — snap, don't replay (rules 4/5). */
  snapOnly: boolean;
}

export function computeWalkPlan(
  prev: PipelineView | null,
  next: PipelineView,
  opts: WalkPlanOptions,
): WalkPlan {
  if (opts.firstPaint || opts.snapOnly || prev === null) {
    return {
      motions: next.lanes.map((lane) => ({
        kind: 'snap' as const,
        instrument: lane.instrument,
        room: roomFor(lane),
      })),
      total_ms: 0,
    };
  }

  const prevByInstrument = new Map(prev.lanes.map((lane) => [lane.instrument, lane]));
  const nextInstruments = new Set(next.lanes.map((lane) => lane.instrument));
  const motions: ChipMotion[] = [];

  for (const lane of next.lanes) {
    const prevLane = prevByInstrument.get(lane.instrument);
    const room = roomFor(lane);

    if (prevLane === undefined) {
      motions.push({ kind: 'appear', instrument: lane.instrument, room });
      continue;
    }

    const prevRoom = roomFor(prevLane);

    if (lane.trace_id === null) {
      // Aged to idle — the clock passing, not something the system did (rule 8).
      if (prevLane.trace_id !== null || prevRoom !== 'lobby') {
        motions.push({ kind: 'snap', instrument: lane.instrument, room: 'lobby' });
      }
      continue;
    }

    if (prevLane.trace_id === lane.trace_id) {
      const fromIdx = roomIndex(prevRoom);
      const toIdx = roomIndex(room);
      if (toIdx === fromIdx) continue; // same room — any cell-state change is the renderer's ring, not motion
      if (toIdx < fromIdx) {
        // A retry regressed the room; there is no recorded forward transition to walk.
        motions.push({ kind: 'snap', instrument: lane.instrument, room });
        continue;
      }
      motions.push(
        walkOrSnap(lane, next, prevRoom, fromIdx, toIdx, anchorTime(lane, prevRoom), room),
      );
      continue;
    }

    // Trace rotated (or a fresh trace left the Lobby): back to Analysts, then
    // forward through the NEW trace's recorded stages (rule 7).
    motions.push(
      walkOrSnap(lane, next, prevRoom, -1, roomIndex(room), parseTime(lane.started_at), room),
    );
  }

  for (const prevLane of prev.lanes) {
    if (!nextInstruments.has(prevLane.instrument)) {
      motions.push({ kind: 'depart', instrument: prevLane.instrument, room: roomFor(prevLane) });
    }
  }

  let total = 0;
  for (const motion of motions) {
    if (motion.kind === 'walk' && motion.total_ms > total) total = motion.total_ms;
  }
  return { motions, total_ms: total };
}

/**
 * `buildWalk`, degrading to a snap when there is nothing to walk (PR #582
 * review). A rotated lane whose new trace has a `trace_id` but no reached
 * cells yet stands in the Lobby, so `toIdx` is -1 and the hop range is empty
 * — and a zero-hop `walk` is not a walk, it is a placement that the renderer
 * would animate for 0ms. Any other empty-step case degrades the same way.
 */
function walkOrSnap(
  lane: PipelineLane,
  view: PipelineView,
  from: RoomId,
  fromIdx: number,
  toIdx: number,
  anchor: number | null,
  destination: RoomId,
): ChipMotion {
  if (toIdx < 0) return { kind: 'snap', instrument: lane.instrument, room: destination };
  const walk = buildWalk(lane, view, from, fromIdx, toIdx, anchor);
  if (walk.hops.length === 0) {
    return { kind: 'snap', instrument: lane.instrument, room: destination };
  }
  return walk;
}

/**
 * Build the hop sequence through stages `(fromIdx, toIdx]`, entering only the
 * cells with a non-null `recorded_at` (rule 6) — plus the destination room
 * itself, whose transition is evidenced either by its own recorded row or,
 * when the destination cell is `live`, by `current_tick` (`live_entered_at`
 * is its clock; the spec's rule 1 names both sources).
 */
function buildWalk(
  lane: PipelineLane,
  view: PipelineView,
  from: RoomId,
  fromIdx: number,
  toIdx: number,
  anchor: number | null,
): ChipMotion & { kind: 'walk' } {
  const steps: { room: PipelineStage; time: number | null }[] = [];
  for (let i = fromIdx + 1; i <= toIdx; i++) {
    const stage = stageAt(i);
    if (stage === undefined) break;
    const cell = lane.cells.find((c) => c.stage === stage);
    let time = parseTime(cell?.recorded_at ?? null);
    const isDestination = i === toIdx;
    if (time === null && isDestination && view.live_trace_id === lane.trace_id) {
      time = parseTime(view.live_entered_at);
    }
    if (time !== null || isDestination) steps.push({ room: stage, time });
  }

  const gaps: number[] = [];
  let prevTime = anchor;
  for (const step of steps) {
    const gap =
      step.time !== null && prevTime !== null && step.time > prevTime ? step.time - prevTime : 0;
    gaps.push(gap);
    if (step.time !== null) prevTime = step.time;
  }

  const durations = allocateHopDurations(gaps);
  const hops: WalkHop[] = steps.map((step, i) => ({
    room: step.room,
    duration_ms: durations[i] ?? HOP_MIN_MS,
  }));
  return {
    kind: 'walk',
    instrument: lane.instrument,
    from,
    hops,
    total_ms: hops.reduce((sum, hop) => sum + hop.duration_ms, 0),
  };
}

/**
 * The recorded moment the chip's previous room was entered — the baseline the
 * first hop's gap is measured from. Read from the NEXT snapshot's lane (same
 * trace, so a previously-live cell now carries its completed row).
 */
function anchorTime(lane: PipelineLane, prevRoom: RoomId): number | null {
  if (prevRoom === 'lobby') return parseTime(lane.started_at);
  const cell = lane.cells.find((c) => c.stage === prevRoom);
  return parseTime(cell?.recorded_at ?? null) ?? parseTime(lane.started_at);
}

function parseTime(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Turn recorded gaps into hop durations: proportional to the gaps, each hop
 * clamped to `[HOP_MIN_MS, HOP_MAX_MS]`, and the walk's total scaled down —
 * water-filling so no hop drops below the floor — to fit `WALK_BUDGET_MS`
 * (Motion rule 2).
 */
function allocateHopDurations(gaps: readonly number[]): number[] {
  const n = gaps.length;
  if (n === 0) return [];
  if (n * HOP_MIN_MS >= WALK_BUDGET_MS) return gaps.map(() => HOP_MIN_MS);

  const durations = gaps.map((gap) => Math.min(HOP_MAX_MS, Math.max(HOP_MIN_MS, gap)));
  const total = durations.reduce((sum, d) => sum + d, 0);
  if (total <= WALK_BUDGET_MS) return durations;

  // Scale down to the budget, but never below the per-hop floor: hops the
  // scale would push under the floor are pinned at it and the remaining
  // budget is redistributed over the rest.
  const pinned = durations.map(() => false);
  let budget = WALK_BUDGET_MS;
  for (;;) {
    let freeTotal = 0;
    for (let i = 0; i < n; i++) {
      if (!pinned[i]) freeTotal += durations[i] ?? 0;
    }
    if (freeTotal === 0 || freeTotal <= budget) break;
    const scale = budget / freeTotal;
    let pinnedAny = false;
    for (let i = 0; i < n; i++) {
      const d = durations[i];
      if (pinned[i] || d === undefined) continue;
      if (d * scale < HOP_MIN_MS) {
        durations[i] = HOP_MIN_MS;
        pinned[i] = true;
        budget -= HOP_MIN_MS;
        pinnedAny = true;
      }
    }
    if (!pinnedAny) {
      for (let i = 0; i < n; i++) {
        const d = durations[i];
        if (!pinned[i] && d !== undefined) durations[i] = Math.floor(d * scale);
      }
      break;
    }
  }
  return durations;
}
