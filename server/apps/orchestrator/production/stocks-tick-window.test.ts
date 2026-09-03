/**
 * The defect: `stocksTradingWindow` (#706) gates the whole pipeline pass, and
 * the Trader — the only thing that flattens — runs inside that pass. An entry
 * window closing at 15:45 therefore deletes every tick that could satisfy
 * flat-by-close, and nothing anywhere logs that it has.
 *
 * `trading-window.test.ts` asserted 09:00 no, 14:35 yes, 15:45 no, and that the
 * calendar's `sessionEnd` had not moved. All four still pass with the flatten
 * unreachable — none of them asks whether a tick EXISTS when the flatten needs
 * one. That question is this file.
 */
import { describe, expect, it } from 'vitest';

import {
  AlwaysOpenCalendar,
  LseRegularHoursCalendar,
  londonEntryWindow,
  type TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import { UniverseScheduler } from '../scheduler.js';
import type { UniverseInstrument } from '../types.js';
import { withFlattenTail } from './stocks-tick-window.js';

/** `DEFAULT_TRADER_CONFIG.flatten_before_close_ms` (`trader/types.ts:236`). */
const FLATTEN_MS = 5 * 60 * 1_000;

const UNIVERSE: readonly UniverseInstrument[] = [
  { asset: '3USL', asset_class: 'stocks', subclass: 'index_etp_3x' },
  { asset: 'BTC-USD', asset_class: 'crypto' },
];

/** A Wednesday, no UK bank holiday, inside British Summer Time. LSE close 16:30. */
const at = (hhmm: string): Date => new Date(`2026-08-19T${hhmm}:00+01:00`);

const CALENDAR = new LseRegularHoursCalendar();

const composed = withFlattenTail(londonEntryWindow(), CALENDAR, FLATTEN_MS);

const stocksFiringAt = (instant: Date, window: (i: Date) => boolean): boolean =>
  new UniverseScheduler({ universe: UNIVERSE, calendar: CALENDAR, stocksTradingWindow: window })
    .nextTick({ now: () => instant })
    .instruments.some((i) => i.asset_class === 'stocks');

describe('the flatten tail is reachable', () => {
  it('produces a stocks tick inside [sessionEnd - flatten, sessionEnd)', () => {
    // The assertion the original A3 change needed and did not have. 16:25 is
    // the window's opening edge, 16:29 its last minute.
    expect(stocksFiringAt(at('16:25'), composed)).toBe(true);
    expect(stocksFiringAt(at('16:29'), composed)).toBe(true);
  });

  it('and the bare entry window does NOT — this is the defect, pinned', () => {
    // Kept as an assertion rather than a comment: if `londonEntryWindow` ever
    // grows the tail itself, composing it here would be double work and this
    // line is what says so.
    const bare = londonEntryWindow();
    expect(stocksFiringAt(at('16:25'), bare)).toBe(false);
    expect(stocksFiringAt(at('16:29'), bare)).toBe(false);
  });

  it('leaves the dead zone between the two spans closed', () => {
    // 15:45-16:25 stays off, which is the whole point of the narrowing. Nothing
    // in that span needs a tick: equity brackets rest at the venue as
    // `order_class: 'bracket'`, fills ingest on their own cadence, and marks
    // are fetched per call rather than accumulated per tick.
    for (const time of ['15:45', '16:00', '16:24']) {
      expect(stocksFiringAt(at(time), composed)).toBe(false);
    }
  });

  it('does not widen the entry window itself', () => {
    // The tail must not become a second entry opportunity by the back door.
    // The Trader refuses entries inside it (`decide.ts:361` returns
    // `skip('session_closing')`), but the scheduler must not be the thing
    // relying on that.
    expect(composed(at('09:00'))).toBe(false);
    expect(composed(at('14:35'))).toBe(true);
    expect(composed(at('15:45'))).toBe(false);
  });

  it('still cannot open a session the calendar has closed', () => {
    // A Saturday at 16:26 is inside the tail by wall clock and shut by venue.
    // `nextTick` evaluates `isOpen` first, so the scheduler holds this line
    // regardless of what the predicate says.
    const saturday = new Date('2026-08-22T16:26:00+01:00');
    expect(stocksFiringAt(saturday, composed)).toBe(false);

    // ...and the predicate is asserted SEPARATELY, because "the calendar holds
    // it" is only true while the calendar is consulted first. If `sessionEnd`
    // ever answered on a closed day, a predicate that admitted this instant on
    // its own authority would put a shut venue back in the tick plan the moment
    // that ordering changed. Two assertions, because one of them is about the
    // composition and the other is about the piece.
    expect(composed(saturday)).toBe(false);
  });

  it('is inert past the close rather than answering a past close itself', () => {
    // 16:31 is after the LSE close: `remaining` is negative. A past close is
    // `withinFlattenWindow`'s question and it answers "flatten" (#691); this
    // predicate must not pre-empt that by keeping the instrument in the plan on
    // its own authority. The calendar has it shut anyway.
    expect(composed(at('16:31'))).toBe(false);
  });

  it('adds no tail to a venue that never closes', () => {
    // `AlwaysOpenCalendar.sessionEnd` is null (#667), which is crypto. What
    // flat-by-close means there is an open thesis amendment, so the union must
    // reduce to the entry window rather than invent a boundary.
    const alwaysOpen = withFlattenTail(londonEntryWindow(), new AlwaysOpenCalendar(), FLATTEN_MS);

    expect(alwaysOpen(at('14:35'))).toBe(true);
    expect(alwaysOpen(at('16:26'))).toBe(false);
  });

  it('tracks the configured window rather than a 5-minute constant', () => {
    // The flatten offset is injected config because it is an OFFSET resolved
    // through the instrument's own TradingCalendar (#657, #668): the paper
    // venue closes 16:00 ET and the live LSE leg 16:30 London (12:30 on a
    // half-day), so any shared wall-clock constant would be wrong for one of
    // them. A tail hardcoded to 5 minutes would go stale silently — the same
    // failure shape as the window itself.
    const wide = withFlattenTail(londonEntryWindow(), CALENDAR, 30 * 60_000);

    expect(wide(at('16:05'))).toBe(true);
    expect(composed(at('16:05'))).toBe(false);
  });

  it('propagates a calendar that cannot resolve a close rather than swallowing it (#691)', () => {
    // The `TradingCalendar` port documents that `sessionEnd` MAY THROW when its
    // search is exhausted, and that a throw means "this venue HAS a close and I
    // could not find it" — a broken calendar, not crypto. This is the second of
    // the port's two money-path callers, and the one OUTSIDE `runTickPlan`'s
    // per-instrument catch: it runs in `UniverseScheduler.nextTick`, so the
    // throw is caught by `runOnce` in production.ts and logged as `tick failed`
    // at error level.
    //
    // The tempting "hardening" is a try/catch here returning false. That is the
    // silent-disable this whole ticket is about: false means the flatten tail
    // vanishes, stocks drop out of the plan for the rest of the session, the
    // Trader never gets a tick to flatten on, and the book carries overnight
    // against ADR-0014 with nothing at error level to find it by. The loud
    // failure is the correct one, so it is pinned.
    const brokenCalendar = {
      isOpen: () => true,
      isTradingDay: () => true,
      sessionStart: () => at('08:00'),
      sessionEnd: () => {
        throw new Error('No LSE session close found within 10 days after ...');
      },
      // Cast to the PORT, not to `LseRegularHoursCalendar`: `withFlattenTail`
      // takes the interface, and the fault being modelled is any implementer's
      // — the port's three implementations are all in one file today, but the
      // seam is injected (`ProductionConfig.tradingCalendar`).
    } as unknown as TradingCalendar;

    // 16:26 is inside the flatten tail and outside the entry window, so the
    // predicate must actually consult the calendar to answer.
    const brittle = withFlattenTail(londonEntryWindow(), brokenCalendar, FLATTEN_MS);

    expect(() => brittle(at('16:26'))).toThrow(/No LSE session close found/);
  });
});
