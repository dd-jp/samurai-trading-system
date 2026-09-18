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
    expect(stocksFiringAt(at('09:00'))).toBe(false);
  });

  it('fires equities inside the overlap', () => {
    expect(stocksFiringAt(at('14:35'))).toBe(true);
  });

  it('closes entries at 15:45, leaving 40 minutes to the flatten', () => {
    expect(stocksFiringAt(at('15:44'))).toBe(true);
    expect(stocksFiringAt(at('15:45'))).toBe(false);
    expect(stocksFiringAt(at('16:00'))).toBe(false);

    expect(stocksFiringAt(at('16:26'))).toBe(false);
  });

  it('narrows rather than opens — a closed venue stays closed', () => {
    const saturday = new Date('2026-08-22T14:35:00+01:00');
    expect(stocksFiringAt(saturday)).toBe(false);
  });

  it('gates crypto on the same calendar and window as everything else (#738)', () => {
    const cryptoFiringAt = (time: string): boolean =>
      schedulerAt(true)
        .nextTick(clockAt(at(time)))
        .instruments.some((i) => i.asset_class === 'crypto');

    expect(cryptoFiringAt('09:00')).toBe(false);
    expect(cryptoFiringAt('14:35')).toBe(true);
    expect(cryptoFiringAt('15:45')).toBe(false);
  });

  it('is off by default, so existing profiles and the harness are unchanged', () => {
    expect(stocksFiringAt(at('09:00'), false)).toBe(true);
  });

  it('does NOT move the session end the flatten offsets from', () => {
    const calendar = new LseRegularHoursCalendar();
    const end = calendar.sessionEnd(at('14:35'));

    expect(end).not.toBeNull();
    expect((end as Date).toISOString()).toBe(new Date('2026-08-19T16:30:00+01:00').toISOString());
  });
});

describe('the paper profile actually carries the window', () => {
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

    expect(window(new Date('2026-01-14T14:35:00Z'))).toBe(true);
    expect(window(new Date('2026-08-19T13:35:00Z'))).toBe(true);

    expect(window(new Date('2026-01-14T13:35:00Z'))).toBe(false);

    expect(window(new Date('2026-08-19T15:00:00Z'))).toBe(false);
    expect(window(new Date('2026-01-14T16:00:00Z'))).toBe(false);
  });

  it('refuses an inverted window rather than silently matching nothing', () => {
    expect(() => londonEntryWindow(16 * 60, 14 * 60)).toThrow(/startMinutes < endMinutes/);
  });

  it('refuses a minute-of-day outside [0, 1440] rather than never closing', () => {
    expect(() => londonEntryWindow(14 * 60 + 30, 1545)).toThrow(/whole minute-of-day/);
    expect(() => londonEntryWindow(14 * 60 + 30, 1545)).toThrow(/15:45 is 945/);

    expect(() => londonEntryWindow(-60, 15 * 60)).toThrow(/whole minute-of-day/);
    expect(() => londonEntryWindow(14.5 * 60 + 0.5, 15 * 60)).toThrow(/whole minute-of-day/);

    expect(() => londonEntryWindow(14 * 60, 24 * 60)).not.toThrow();
  });

  it('slides an hour against the US tape in the UK/US DST gap weeks', () => {
    const window = londonEntryWindow();

    expect(window(new Date('2026-03-19T14:30:00Z'))).toBe(true);
    expect(window(new Date('2026-03-19T13:35:00Z'))).toBe(false);

    expect(window(new Date('2026-03-19T15:44:00Z'))).toBe(true);

    expect(window(new Date('2026-04-16T13:30:00Z'))).toBe(true);
  });
});
