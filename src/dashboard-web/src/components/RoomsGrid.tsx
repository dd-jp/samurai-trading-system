/**
 * The rooms hero (dashboard-spec.md, "Rooms hero"): seven numbered rooms plus
 * the Lobby in a 4x2 grid, with one sigil chip per instrument standing in the
 * room its trace last reached.
 *
 * Chips live on an absolutely-positioned floor layer over the grid rather than
 * inside the room elements, because a walk crosses rooms: a chip that is a DOM
 * child of its room cannot animate into another one. The floor is a child of
 * the scrolling container so chips scroll with the rooms rather than detaching
 * from them.
 *
 * **Room 04's lights-off is derived, not hardcoded.** The spec's rule is that
 * the caveat "retires itself from the data rather than needing an edit" —
 * `audit_log.stage` is unconstrained TEXT, so the day the invalidation stage
 * ships its rows appear and this room lights up with no change to this file.
 */

import type { PipelineLane, PipelineView } from '@contracts';
import type { CSSProperties, RefObject } from 'react';
import type { RoomId, RoomsLayout } from '../lib/room-layout.ts';
import { ROOM_META } from '../lib/vocabulary.ts';
import { SigilChip } from './SigilChip.tsx';

export interface RoomsGridProps {
  view: PipelineView;
  layout: RoomsLayout;
  selectedInstrument: string | null;
  onSelect: (instrument: string) => void;
  floorRef: RefObject<HTMLDivElement | null>;
  registerRoomRef: (room: RoomId, element: HTMLElement | null) => void;
  registerChipRef: (instrument: string, element: HTMLElement | null) => void;
}

/**
 * True once any lane has an invalidation cell that is not `not_reached` — i.e.
 * once the stage has actually run for somebody. Until then the room is drawn
 * lights-off and says why.
 */
function invalidationHasShipped(lanes: readonly PipelineLane[]): boolean {
  return lanes.some((lane) =>
    lane.cells.some((cell) => cell.stage === 'invalidation' && cell.state !== 'not_reached'),
  );
}

export function RoomsGrid(props: RoomsGridProps) {
  const { view, layout, selectedInstrument, onSelect, floorRef } = props;
  const { registerRoomRef, registerChipRef } = props;

  const lanesByInstrument = new Map(view.lanes.map((lane) => [lane.instrument, lane]));
  const lightsOff = !invalidationHasShipped(view.lanes);

  const liveLane =
    view.live_trace_id === null
      ? undefined
      : view.lanes.find((lane) => lane.trace_id === view.live_trace_id);
  const liveRoom =
    liveLane === undefined ? null : (layout.chips[liveLane.instrument]?.room ?? null);
  const selectedRoom =
    selectedInstrument === null ? null : (layout.chips[selectedInstrument]?.room ?? null);

  return (
    <section className="rooms-panel" aria-label="Pipeline rooms">
      <div className="panel-head">
        <h2>Pipeline</h2>
        <span className="panel-sub">
          ≤ 24 instruments · 15-minute window · walks replay recorded transitions only
        </span>
      </div>
      <div className="rooms-scroll">
        <div className="rooms-hero">
          {layout.rooms.map((room, index) => {
            const meta = ROOM_META[room.room];
            const isDark = room.room === 'invalidation' && lightsOff;
            const isLive = liveRoom === room.room;
            const className = [
              'room',
              room.room === 'lobby' ? 'room-lobby' : '',
              isDark ? 'room-lights-off' : '',
              isLive ? 'room-live' : '',
              selectedRoom === room.room ? 'room-selected' : '',
            ]
              .filter((part) => part !== '')
              .join(' ');
            return (
              <div
                key={room.room}
                className={className}
                data-room={room.room}
                // Per-room delay for the power-on keyframe. A custom property
                // rather than a class per room: 8 rooms, one rule.
                style={{ '--room-index': index } as CSSProperties}
                ref={(element) => registerRoomRef(room.room, element)}
              >
                <span className="room-corner room-corner-tl" aria-hidden="true" />
                <span className="room-corner room-corner-br" aria-hidden="true" />
                <div className="room-heading">
                  {meta.number !== null && <span className="room-number">{meta.number}</span>}
                  <h3 className="room-name">{meta.name}</h3>
                  {isLive && <span className="room-live-word">live</span>}
                </div>
                <p className="room-blurb">
                  {isDark ? 'specced and not built — devils-advocate-spec.md' : meta.blurb}
                </p>
                {room.overflowCount > 0 && (
                  <span
                    className="room-overflow"
                    // `role="img"` so the accessible name replaces the "+N"
                    // text: the count is the visible signal, the names of the
                    // collapsed instruments are the spoken one.
                    role="img"
                    aria-label={`${room.overflowCount} more in ${meta.name}: ${room.overflowChips.join(', ')}`}
                  >
                    +{room.overflowCount}
                  </span>
                )}
                <span className="room-kanji" aria-hidden="true">
                  {meta.kanji}
                </span>
              </div>
            );
          })}
          <div className="rooms-floor" ref={floorRef}>
            {layout.rooms.flatMap((room) =>
              room.visibleChips.map((instrument) => {
                const lane = lanesByInstrument.get(instrument);
                // Unreachable, and enforced as such rather than rendered
                // around (PR #607 review round 2, revisiting #606 item 6):
                // `computeLayout` builds every `visibleChips` entry FROM
                // `view.lanes`, and `App` passes the same view to both, so
                // `visibleChips ⊆ lanes` holds by construction. That invariant
                // is guarded by a test in `room-layout.test.ts`, which is the
                // right place for it — operator-facing text for a state that
                // cannot occur is reassurance, not information, and it would
                // sit on the hot path of every repaint to say nothing.
                if (lane === undefined) return null;
                return (
                  <SigilChip
                    key={instrument}
                    lane={lane}
                    roomName={ROOM_META[room.room].name}
                    selected={selectedInstrument === instrument}
                    live={liveLane?.instrument === instrument}
                    onSelect={onSelect}
                    registerRef={registerChipRef}
                  />
                );
              }),
            )}
          </div>
        </div>
      </div>
      {view.lanes.length === 0 && (
        <p className="empty-state">
          No lanes on the wire — the pipeline view reports no instrument in the last 15 minutes.
        </p>
      )}
    </section>
  );
}
