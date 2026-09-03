/**
 * Room placement for the pipeline theater (issue #537; dashboard-spec.md
 * "Pipeline theater" / "Rooms hero"). Pure functions of the wire shapes —
 * no React, no DOM, no clock.
 *
 * Which room a lane occupies is re-specified here from the pipeline-types
 * contract rather than copied from the old stage-rail renderer:
 *  - a `live` cell wins outright — `current_tick` says the trace is THERE
 *    right now, whatever older rows exist;
 *  - otherwise the furthest `done`/`stopped` stage — the last place the
 *    trace verifiably stood (`skipped` and `not_reached` cells were never
 *    visited, so they can't hold a chip);
 *  - otherwise the Lobby — an idle lane reads as idle, it never vanishes.
 */

import type { PipelineLane, PipelineStage, PipelineView } from '@contracts';

/** A room in the theater: one of the six stages, or the Lobby for idle lanes. */
export type RoomId = PipelineStage | 'lobby';

/**
 * Stage order, redeclared from `PIPELINE_STAGES` (`contracts/pipeline.ts`).
 *
 * The original reason for redeclaring — "so the backend never enters the
 * bundle" — no longer applies: `contracts/` is dependency-free by construction
 * and `contracts/boundary.test.ts` enforces it, so importing the value would
 * drag nothing server-side along with it. The list stays because it now earns
 * its keep differently: this is the order rooms are DRAWN in, which is the
 * client's business, and pinning it here means a future reordering of the wire
 * constant cannot silently rearrange the theater.
 *
 * `satisfies` pins every member to the wire type; the `Exclude` check below
 * fails to compile if the wire union ever grows a stage this list is missing.
 */
const STAGE_ORDER = [
  'analysts',
  'debate',
  'trader',
  'risk',
  'verdict',
  'execution',
] as const satisfies readonly PipelineStage[];

type MissingStage = Exclude<PipelineStage, (typeof STAGE_ORDER)[number]>;
const _stageOrderIsExhaustive: MissingStage extends never ? true : never = true;
void _stageOrderIsExhaustive;

/**
 * Canonical room order — matches the `ROOMS` list in `App.tsx`: Lobby first,
 * then rooms 01–06 in pipeline order.
 */
export const ROOM_ORDER = ['lobby', ...STAGE_ORDER] as const satisfies readonly RoomId[];

/** 4x2 grid: 4 columns, so the row wraps between room 03 (trader) and 04 (risk). */
const GRID_COLUMNS = 4;

/** More than this many chips in one room collapse to the first 3 plus a "+N" affordance. */
export const COLLAPSE_VISIBLE_CHIPS = 3;

const STAGE_INDEX: Readonly<Record<PipelineStage, number>> = Object.fromEntries(
  STAGE_ORDER.map((stage, i) => [stage, i]),
) as Record<PipelineStage, number>;

/** Index of a room along the walkable path; the Lobby sits before Analysts. */
export function roomIndex(room: RoomId): number {
  return room === 'lobby' ? -1 : STAGE_INDEX[room];
}

/** The stage at walk-path index `i` (0 = analysts … 5 = execution). */
export function stageAt(i: number): PipelineStage | undefined {
  return STAGE_ORDER[i];
}

/** Which room a lane's chip stands in. See the module doc for the precedence rules. */
export function roomFor(lane: PipelineLane): RoomId {
  let furthest = -1;
  for (const cell of lane.cells) {
    if (cell.state === 'live') return cell.stage;
    if (cell.state === 'done' || cell.state === 'stopped') {
      const idx = STAGE_INDEX[cell.stage];
      if (idx > furthest) furthest = idx;
    }
  }
  const stage = STAGE_ORDER[furthest];
  return stage ?? 'lobby';
}

export interface RoomGridPosition {
  row: number;
  column: number;
}

/** One room's occupancy: every chip in wire order, split into visible and "+N" overflow. */
export interface RoomOccupancy {
  room: RoomId;
  grid: RoomGridPosition;
  /** Instruments standing in this room, in wire (lane) order. */
  chips: string[];
  /** The chips actually drawn — all of them, or the first 3 when over the collapse limit. */
  visibleChips: string[];
  /** The chips folded behind the "+N" affordance. */
  overflowChips: string[];
  /** N of the "+N" affordance; 0 when nothing is collapsed. */
  overflowCount: number;
}

export interface ChipPlacement {
  instrument: string;
  room: RoomId;
  /**
   * Position within the room, assigned in wire order. The wire order is
   * stable across polls (the store returns lanes in a fixed order), so a
   * chip keeps its slot until occupancy actually changes — chips never
   * shuffle between two identical snapshots.
   */
  slot: number;
  /** True when this chip is folded behind the room's "+N" affordance. */
  collapsed: boolean;
}

export interface RoomsLayout {
  /** All 7 rooms in canonical `ROOM_ORDER`, occupied or not — the grid never reflows. */
  rooms: RoomOccupancy[];
  /** Per-instrument placement lookup. */
  chips: Record<string, ChipPlacement>;
}

/** Lay every lane's chip into the 4x2 rooms grid. Pure function of the view. */
export function computeLayout(view: PipelineView): RoomsLayout {
  const occupants = new Map<RoomId, string[]>(ROOM_ORDER.map((room) => [room, []]));
  for (const lane of view.lanes) {
    occupants.get(roomFor(lane))?.push(lane.instrument);
  }

  const rooms: RoomOccupancy[] = ROOM_ORDER.map((room, i) => {
    const chips = occupants.get(room) ?? [];
    const collapsed = chips.length > COLLAPSE_VISIBLE_CHIPS;
    return {
      room,
      grid: { row: Math.floor(i / GRID_COLUMNS), column: i % GRID_COLUMNS },
      chips,
      visibleChips: collapsed ? chips.slice(0, COLLAPSE_VISIBLE_CHIPS) : chips,
      overflowChips: collapsed ? chips.slice(COLLAPSE_VISIBLE_CHIPS) : [],
      overflowCount: collapsed ? chips.length - COLLAPSE_VISIBLE_CHIPS : 0,
    };
  });

  const chips: Record<string, ChipPlacement> = {};
  for (const room of rooms) {
    room.chips.forEach((instrument, slot) => {
      chips[instrument] = {
        instrument,
        room: room.room,
        slot,
        collapsed: room.overflowCount > 0 && slot >= COLLAPSE_VISIBLE_CHIPS,
      };
    });
  }

  return { rooms, chips };
}
