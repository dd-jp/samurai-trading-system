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

    expect(end.toISOString()).toBe(new Date('2026-08-19T16:30:00+01:00').toISOString());
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
});
