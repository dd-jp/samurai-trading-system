/**
 * A3 (#706) — the equity entry window, and the boundary it must not move.
 *
 * The window narrows when equities may be ENTERED. The calendar decides when
 * the venue is open, and the same calendar object resolves `sessionEnd` for
 * the flatten rule (#657: close minus 5 minutes, an offset rather than a wall
 * clock). Merging the two would silently move the flatten, which is a
 * money-path rule — so the test that matters most here is the one asserting
 * the LSE close is still 16:30 with the window installed.
 */
import { describe, expect, it } from 'vitest';

import {
  LseRegularHoursCalendar,
  londonEntryWindow,
} from '../../providers/market-data-service/index.js';
import { paperStartingProfile } from './paper-profile.js';
import { UniverseScheduler } from './scheduler.js';
import type { UniverseInstrument } from './types.js';

const UNIVERSE: readonly UniverseInstrument[] = [
  { asset: '3USL', asset_class: 'stocks', subclass: 'index_etp_3x' },
  { asset: 'BTC-USD', asset_class: 'crypto' },
];

/** A Wednesday, no UK bank holiday, inside British Summer Time. */
const at = (hhmm: string): Date => new Date(`2026-08-19T${hhmm}:00+01:00`);

const clockAt = (instant: Date) => ({ now: () => instant });

const schedulerAt = (windowed: boolean) =>
  new UniverseScheduler({
    universe: UNIVERSE,
    calendar: new LseRegularHoursCalendar(),
    ...(windowed ? { stocksTradingWindow: londonEntryWindow() } : {}),
  });

const stocksFiringAt = (instant: Date, windowed = true): boolean =>
  schedulerAt(windowed)
    .nextTick(clockAt(instant))
    .instruments.some((i) => i.asset_class === 'stocks');

describe('the equity entry window (#706)', () => {
  it('does not fire equities at the LSE open, hours before the overlap', () => {
    // 09:00 London is a valid LSE session — and five and a half hours before
    // any US tape exists. Every measurement the brackets rest on is computed
    // on US tape (#656: no free LSE intraday history), so this is the hour
    // the window exists to refuse.
    expect(stocksFiringAt(at('09:00'))).toBe(false);
  });

  it('fires equities inside the overlap', () => {
    expect(stocksFiringAt(at('14:35'))).toBe(true);
  });

  it('closes entries at 15:45, leaving 40 minutes to the flatten', () => {
    expect(stocksFiringAt(at('15:44'))).toBe(true);
    // Half-open at the top, matching `isOpen`: 15:45:00 is already past.
    expect(stocksFiringAt(at('15:45'))).toBe(false);
    expect(stocksFiringAt(at('16:00'))).toBe(false);

    // What this file tests is the BARE entry window, which is not what the
    // composition root installs. On its own it also removes every tick in the
    // flatten span, which switched flat-by-close off — see
    // `production/stocks-tick-window.test.ts`. Asserted here so the two files
    // cannot drift into disagreeing about what this predicate does.
    expect(stocksFiringAt(at('16:26'))).toBe(false);
  });

  it('narrows rather than opens — a closed venue stays closed', () => {
    // A Saturday inside the window's wall-clock hours. The window must not be
    // able to authorise a tick the calendar refuses.
    const saturday = new Date('2026-08-22T14:35:00+01:00');
    expect(stocksFiringAt(saturday)).toBe(false);
  });

  it('leaves crypto untouched at every hour', () => {
    // Crypto never consults the calendar and must never consult the window.
    for (const time of ['02:00', '09:00', '14:35', '15:45', '23:30']) {
      const plan = schedulerAt(true).nextTick(clockAt(at(time)));
      expect(plan.instruments.some((i) => i.asset_class === 'crypto')).toBe(true);
    }
  });

  it('is off by default, so existing profiles and the harness are unchanged', () => {
    expect(stocksFiringAt(at('09:00'), false)).toBe(true);
  });

  it('does NOT move the session end the flatten offsets from', () => {
    // The reason the window is a scheduler predicate rather than a narrowed
    // calendar. #657 fixed the flatten at close minus 5 minutes resolved
    // through this same object; if installing a 15:45 window moved the close,
    // the flatten would silently follow it to 15:40.
    const calendar = new LseRegularHoursCalendar();
    const end = calendar.sessionEnd(at('14:35'));

    // `sessionEnd` returns null for a venue with no close (`AlwaysOpenCalendar`,
    // #667). Asserted rather than `!`-ed away: a null here would mean the LSE
    // calendar had stopped bounding the session, which is the failure this
    // test exists to catch, and `.toISOString()` on null throws an unreadable
    // TypeError instead of naming it.
    expect(end).not.toBeNull();
    expect((end as Date).toISOString()).toBe(new Date('2026-08-19T16:30:00+01:00').toISOString());
  });
});

describe('the paper profile actually carries the window', () => {
  // The link most likely to rot. A window with a seam, a factory and seven
  // green unit tests that no composition root installs is this repo's
  // dominant defect class — a tested mechanism nothing calls.
  it('sets stocksTradingWindow, and it is the overlap window', () => {
    const window = paperStartingProfile('paper').stocksTradingWindow;

    expect(window).toBeTypeOf('function');
    expect(window?.(at('09:00'))).toBe(false);
    expect(window?.(at('14:35'))).toBe(true);
    expect(window?.(at('15:45'))).toBe(false);
  });
});

describe('londonEntryWindow', () => {
  it('tracks DST rather than a fixed UTC offset', () => {
    const window = londonEntryWindow();

    // The same wall-clock hour sits at two different UTC instants across the
    // year, and a hand-rolled UTC window would be right for only one of them.
    //
    // 14:35 London: 14:35Z in winter (GMT), 13:35Z in summer (BST).
    expect(window(new Date('2026-01-14T14:35:00Z'))).toBe(true);
    expect(window(new Date('2026-08-19T13:35:00Z'))).toBe(true);

    // 13:35Z in WINTER is 13:35 London — before the window opens. A window
    // pinned to the summer offset would wrongly admit it.
    expect(window(new Date('2026-01-14T13:35:00Z'))).toBe(false);

    // 16:00 London, both ways round, is past the last entry.
    expect(window(new Date('2026-08-19T15:00:00Z'))).toBe(false);
    expect(window(new Date('2026-01-14T16:00:00Z'))).toBe(false);
  });

  it('refuses an inverted window rather than silently matching nothing', () => {
    expect(() => londonEntryWindow(16 * 60, 14 * 60)).toThrow(/startMinutes < endMinutes/);
  });

  it('refuses a minute-of-day outside [0, 1440] rather than never closing', () => {
    // The failure this guards is not a crash, it is a window that silently
    // never ends: `minutesSinceMidnight` is always < 1440, so an `endMinutes`
    // of 1545 — clock-style 15:45, the single most likely miscall — makes the
    // upper bound unreachable and arms entries for the entire session,
    // including the flatten tail. Ordering alone accepts it.
    expect(() => londonEntryWindow(14 * 60 + 30, 1545)).toThrow(/whole minute-of-day/);
    expect(() => londonEntryWindow(14 * 60 + 30, 1545)).toThrow(/15:45 is 945/);

    // The other direction is the mirror: a negative start is always true, so
    // the window opens before the venue does.
    expect(() => londonEntryWindow(-60, 15 * 60)).toThrow(/whole minute-of-day/);
    expect(() => londonEntryWindow(14.5 * 60 + 0.5, 15 * 60)).toThrow(/whole minute-of-day/);

    // 1440 itself is a legal END — "up to midnight" — and must not be caught
    // by the bound it sits on.
    expect(() => londonEntryWindow(14 * 60, 24 * 60)).not.toThrow();
  });

  it('slides an hour against the US tape in the UK/US DST gap weeks', () => {
    // Characterisation, not an endorsement — see `stocksTradingWindow`'s
    // docblock in paper-profile.ts. The window is anchored to LONDON
    // wall-clock, and the two countries do not change clocks on the same day:
    // the US springs forward on the 2nd Sunday of March, the UK on the last.
    // Between those dates the offset is 4 hours, not 5.
    const window = londonEntryWindow();

    // 2026-03-19 sits in the gap (US on EDT since Mar 8, UK still on GMT).
    // 14:30 London = 14:30Z = 10:30 ET, an hour after the US cash open — so
    // the window's first admitted instant is 60 minutes into the US session,
    // not 0. The pre-open hour is NOT admitted.
    expect(window(new Date('2026-03-19T14:30:00Z'))).toBe(true);
    expect(window(new Date('2026-03-19T13:35:00Z'))).toBe(false);

    // ...and it closes at 15:45 London = 11:45 ET, i.e. 135 minutes past the
    // US open, past the t0 <= 120 edge of R2's measured entry-offset grid.
    expect(window(new Date('2026-03-19T15:44:00Z'))).toBe(true);

    // Outside the gap the same wall-clock window is 09:30-10:45 ET: on
    // 2026-04-16 both are on summer time, so 14:30 London = 13:30Z = 09:30 ET.
    expect(window(new Date('2026-04-16T13:30:00Z'))).toBe(true);
  });
});
