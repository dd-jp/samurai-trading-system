import { describe, expect, it } from 'vitest';
import { COLLAPSE_VISIBLE_CHIPS, computeLayout, ROOM_ORDER, roomFor } from './room-layout.ts';
import { at, doneThrough, makeLane, makeView } from './test-support.ts';

describe('roomFor', () => {
  it('places a lane in the room of its live cell, outright', () => {
    // A live cell wins even when a later stage carries a done record (a
    // retried trace can leave a done row beyond the stage now live).
    const lane = makeLane({
      instrument: 'BTC-USD',
      trace_id: 't1',
      outcome: 'in_flight',
      cells: {
        analysts: { state: 'done', recorded_at: at(1_000) },
        debate: { state: 'live' },
        risk: { state: 'done', recorded_at: at(2_000) },
      },
    });
    expect(roomFor(lane)).toBe('debate');
  });

  it('falls back to the furthest done/stopped stage', () => {
    const lane = makeLane({
      instrument: 'ETH-USD',
      trace_id: 't2',
      outcome: 'stopped',
      cells: {
        analysts: { state: 'done', recorded_at: at(1_000) },
        debate: { state: 'done', recorded_at: at(2_000) },
        trader: { state: 'stopped', recorded_at: at(3_000) },
      },
    });
    expect(roomFor(lane)).toBe('trader');
  });

  it('ignores skipped cells when finding the furthest stage', () => {
    const lane = makeLane({
      instrument: 'SPY',
      trace_id: 't3',
      outcome: 'stopped',
      cells: {
        analysts: { state: 'done', recorded_at: at(1_000) },
        debate: { state: 'stopped', recorded_at: at(2_000) },
        trader: { state: 'skipped' },
      },
    });
    expect(roomFor(lane)).toBe('debate');
  });

  it('places an idle lane (no reached cells) in the Lobby', () => {
    expect(roomFor(makeLane({ instrument: 'QQQ' }))).toBe('lobby');
  });
});

describe('computeLayout', () => {
  it('lays the 7 rooms out on a 4-column grid, wrapping between rooms 03 and 04', () => {
    const layout = computeLayout(makeView([]));
    expect(layout.rooms.map((r) => r.room)).toEqual([...ROOM_ORDER]);
    // Row 0: Lobby, 01 Analysts, 02 Debate, 03 Trader. Row 1: 04-06.
    const grid = Object.fromEntries(layout.rooms.map((r) => [r.room, r.grid]));
    expect(grid.lobby).toEqual({ row: 0, column: 0 });
    expect(grid.trader).toEqual({ row: 0, column: 3 });
    expect(grid.risk).toEqual({ row: 1, column: 0 });
    expect(grid.execution).toEqual({ row: 1, column: 2 });
  });

  it('assigns slots within a room in wire order', () => {
    const view = makeView([
      doneThrough('BTC-USD', 'a', 'risk'),
      doneThrough('ETH-USD', 'b', 'risk'),
      doneThrough('SPY', 'c', 'debate'),
    ]);
    const layout = computeLayout(view);
    const risk = layout.rooms.find((r) => r.room === 'risk');
    expect(risk?.chips).toEqual(['BTC-USD', 'ETH-USD']);
    expect(layout.chips['BTC-USD']).toMatchObject({ room: 'risk', slot: 0, collapsed: false });
    expect(layout.chips['ETH-USD']).toMatchObject({ room: 'risk', slot: 1, collapsed: false });
    expect(layout.chips.SPY).toMatchObject({ room: 'debate', slot: 0 });
  });

  it('keeps slots stable across polls when nothing moves', () => {
    const lanes = () => [
      doneThrough('BTC-USD', 'a', 'verdict'),
      doneThrough('ETH-USD', 'b', 'verdict'),
      doneThrough('SPY', 'c', 'verdict'),
    ];
    expect(computeLayout(makeView(lanes()))).toEqual(computeLayout(makeView(lanes())));
  });

  it('preserves relative order of remaining chips when one departs a room', () => {
    const before = computeLayout(
      makeView([
        doneThrough('BTC-USD', 'a', 'risk'),
        doneThrough('ETH-USD', 'b', 'risk'),
        doneThrough('SPY', 'c', 'risk'),
      ]),
    );
    const after = computeLayout(
      makeView([
        doneThrough('BTC-USD', 'a', 'risk'),
        doneThrough('ETH-USD', 'b', 'verdict'),
        doneThrough('SPY', 'c', 'risk'),
      ]),
    );
    expect(before.rooms.find((r) => r.room === 'risk')?.chips).toEqual([
      'BTC-USD',
      'ETH-USD',
      'SPY',
    ]);
    // BTC-USD keeps slot 0; SPY compacts up but stays behind BTC-USD.
    expect(after.rooms.find((r) => r.room === 'risk')?.chips).toEqual(['BTC-USD', 'SPY']);
    expect(after.chips['BTC-USD']?.slot).toBe(0);
    expect(after.chips.SPY?.slot).toBe(1);
  });

  it('collapses more than 3 chips in one room to the first 3 plus +N', () => {
    const view = makeView([
      doneThrough('BTC-USD', 'a', 'risk'),
      doneThrough('ETH-USD', 'b', 'risk'),
      doneThrough('SPY', 'c', 'risk'),
      doneThrough('QQQ', 'd', 'risk'),
      doneThrough('AAPL', 'e', 'risk'),
    ]);
    const risk = computeLayout(view).rooms.find((r) => r.room === 'risk');
    expect(risk?.visibleChips).toEqual(['BTC-USD', 'ETH-USD', 'SPY']);
    expect(risk?.overflowChips).toEqual(['QQQ', 'AAPL']);
    expect(risk?.overflowCount).toBe(2);
    const layout = computeLayout(view);
    expect(layout.chips.QQQ?.collapsed).toBe(true);
    expect(layout.chips.SPY?.collapsed).toBe(false);
  });

  it('shows exactly 3 chips uncollapsed', () => {
    const view = makeView([
      doneThrough('BTC-USD', 'a', 'debate'),
      doneThrough('ETH-USD', 'b', 'debate'),
      doneThrough('SPY', 'c', 'debate'),
    ]);
    const debate = computeLayout(view).rooms.find((r) => r.room === 'debate');
    expect(debate?.visibleChips).toHaveLength(COLLAPSE_VISIBLE_CHIPS);
    expect(debate?.overflowChips).toEqual([]);
    expect(debate?.overflowCount).toBe(0);
  });

  /**
   * The invariant `RoomsGrid` relies on instead of rendering a caveat for a
   * state that cannot happen (PR #607 review round 2, revisiting #606 item 6).
   *
   * `RoomsGrid` looks every `visibleChips` entry up in a map built from
   * `view.lanes`; a miss would silently drop a chip, and an instrument missing
   * from the hero reads as "not trading" rather than as a gap. Rather than
   * carry operator-facing text for an unreachable case on the repaint path,
   * the contract is pinned here — where a change to `computeLayout` that
   * invented a chip, or renamed one, fails immediately.
   */
  describe('every placed chip belongs to a lane', () => {
    const views = {
      empty: makeView([]),
      'one lane': makeView([doneThrough('BTC-USD', 'a', 'debate')]),
      'idle lane in the lobby': makeView([makeLane({ instrument: 'SPY', outcome: 'idle' })]),
      'a room past the collapse threshold': makeView([
        doneThrough('BTC-USD', 'a', 'risk'),
        doneThrough('ETH-USD', 'b', 'risk'),
        doneThrough('SPY', 'c', 'risk'),
        doneThrough('QQQ', 'd', 'risk'),
        doneThrough('AAPL', 'e', 'risk'),
      ]),
      'lanes spread across every room': makeView([
        doneThrough('A', 'a', 'analysts'),
        doneThrough('B', 'b', 'debate'),
        doneThrough('C', 'c', 'trader'),
        doneThrough('E', 'e', 'risk'),
        doneThrough('F', 'f', 'verdict'),
        doneThrough('G', 'g', 'execution'),
        makeLane({ instrument: 'H', outcome: 'idle' }),
      ]),
    };

    for (const [name, view] of Object.entries(views)) {
      it(name, () => {
        const layout = computeLayout(view);
        const instruments = new Set(view.lanes.map((lane) => lane.instrument));

        for (const room of layout.rooms) {
          for (const chip of [...room.visibleChips, ...room.overflowChips, ...room.chips]) {
            expect(instruments.has(chip)).toBe(true);
          }
        }
        // The placement lookup `RoomsGrid` reads for the live and selected
        // rooms carries the same guarantee.
        for (const instrument of Object.keys(layout.chips)) {
          expect(instruments.has(instrument)).toBe(true);
        }
        // And nothing is lost on the way in: every lane got a chip, so the
        // subset relation is an equality rather than a licence to drop lanes.
        expect(new Set(layout.rooms.flatMap((room) => room.chips))).toEqual(instruments);
      });
    }
  });
});
