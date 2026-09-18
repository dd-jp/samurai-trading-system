import { describe, expect, it } from 'vitest';

import {
  AlwaysOpenCalendar,
  LseRegularHoursCalendar,
  londonEntryWindow,
  type TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import { UniverseScheduler } from '../scheduler.js';
import type { UniverseInstrument } from '../types.js';
import { postCloseFlattenTail, withFlattenTail } from './stocks-tick-window.js';

const FLATTEN_MS = 5 * 60 * 1_000;

const UNIVERSE: readonly UniverseInstrument[] = [
  { asset: '3USL', asset_class: 'stocks', subclass: 'index_etp_3x' },
  { asset: 'BTC-USD', asset_class: 'crypto' },
];

const at = (hhmm: string): Date => new Date(`2026-08-19T${hhmm}:00+01:00`);

const CALENDAR = new LseRegularHoursCalendar();

const composed = withFlattenTail(londonEntryWindow(), CALENDAR, FLATTEN_MS);

const stocksFiringAt = (instant: Date, window: (i: Date) => boolean): boolean =>
  new UniverseScheduler({ universe: UNIVERSE, calendar: CALENDAR, stocksTradingWindow: window })
    .nextTick({ now: () => instant })
    .instruments.some((i) => i.asset_class === 'stocks');

describe('the flatten tail is reachable', () => {
  it('produces a stocks tick inside [sessionEnd - flatten, sessionEnd)', () => {
    expect(stocksFiringAt(at('16:25'), composed)).toBe(true);
    expect(stocksFiringAt(at('16:29'), composed)).toBe(true);
  });

  it('and the bare entry window does NOT — this is the defect, pinned', () => {
    const bare = londonEntryWindow();
    expect(stocksFiringAt(at('16:25'), bare)).toBe(false);
    expect(stocksFiringAt(at('16:29'), bare)).toBe(false);
  });

  it('leaves the dead zone between the two spans closed', () => {
    for (const time of ['15:45', '16:00', '16:24']) {
      expect(stocksFiringAt(at(time), composed)).toBe(false);
    }
  });

  it('does not widen the entry window itself', () => {
    expect(composed(at('09:00'))).toBe(false);
    expect(composed(at('14:35'))).toBe(true);
    expect(composed(at('15:45'))).toBe(false);
  });

  it('still cannot open a session the calendar has closed', () => {
    const saturday = new Date('2026-08-22T16:26:00+01:00');
    expect(stocksFiringAt(saturday, composed)).toBe(false);

    expect(composed(saturday)).toBe(false);
  });

  it('is inert past the close rather than answering a past close itself', () => {
    expect(composed(at('16:31'))).toBe(false);
  });

  it('adds no tail to a venue that never closes', () => {
    const alwaysOpen = withFlattenTail(londonEntryWindow(), new AlwaysOpenCalendar(), FLATTEN_MS);

    expect(alwaysOpen(at('14:35'))).toBe(true);
    expect(alwaysOpen(at('16:26'))).toBe(false);
  });

  it('tracks the configured window rather than a 5-minute constant', () => {
    const wide = withFlattenTail(londonEntryWindow(), CALENDAR, 30 * 60_000);

    expect(wide(at('16:05'))).toBe(true);
    expect(composed(at('16:05'))).toBe(false);
  });

  it('propagates a calendar that cannot resolve a close rather than swallowing it (#691)', () => {
    const brokenCalendar = {
      isOpen: () => true,
      isTradingDay: () => true,
      sessionStart: () => at('08:00'),
      sessionEnd: () => {
        throw new Error('No LSE session close found within 10 days after ...');
      },
    } as unknown as TradingCalendar;

    const brittle = withFlattenTail(londonEntryWindow(), brokenCalendar, FLATTEN_MS);

    expect(() => brittle(at('16:26'))).toThrow(/No LSE session close found/);
  });
});

describe('postCloseFlattenTail (#1389)', () => {
  const GRACE_MS = 5 * 60 * 1_000;
  const inGrace = postCloseFlattenTail(new LseRegularHoursCalendar(), GRACE_MS);

  it('is true from the bell to the end of the grace, and false either side', () => {
    expect(inGrace(at('16:29'))).toBe(false);
    expect(inGrace(at('16:30'))).toBe(true);
    expect(inGrace(at('16:34'))).toBe(true);
    expect(inGrace(at('16:35'))).toBe(true);
    expect(inGrace(at('16:36'))).toBe(false);
  });

  it('meets the pre-close tail exactly at the bell, with no instant uncovered', () => {
    const beforeTail = withFlattenTail(() => false, new LseRegularHoursCalendar(), FLATTEN_MS);

    for (const hhmm of ['16:26', '16:27', '16:28', '16:29', '16:30', '16:31', '16:32']) {
      expect(beforeTail(at(hhmm)) || inGrace(at(hhmm))).toBe(true);
    }
  });

  it('is false on a venue that never closes — crypto has no close to be past (#667)', () => {
    expect(postCloseFlattenTail(new AlwaysOpenCalendar(), GRACE_MS)(at('16:31'))).toBe(false);
  });

  it('is false the next morning, when the grace is long gone', () => {
    expect(inGrace(new Date('2026-08-20T08:30:00+01:00'))).toBe(false);
  });
});
