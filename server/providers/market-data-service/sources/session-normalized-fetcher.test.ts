import { describe, expect, it } from 'vitest';
import { UsEquityRegularHoursCalendar } from '../trading-calendar.js';
import type { Bar } from '../types.js';
import { InSessionUnderfetchError } from './normalizing-data-source.js';
import type { BarFetcher } from './ohlcv-failover.js';
import { withSessionNormalization } from './session-normalized-fetcher.js';

const EXTENDED_HOURS_UTC = Array.from({ length: 16 }, (_, i) => 8 + i);

const REGULAR_HOURS_UTC = [14, 15, 16, 17, 18, 19];

function isWeekday(date: Date): boolean {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}

function extendedHoursBars(symbol: string, limit: number, asOf: Date): Bar[] {
  const bars: Bar[] = [];
  let cursor = new Date(asOf.getTime() - 3_600_000);

  while (bars.length < limit) {
    if (isWeekday(cursor) && EXTENDED_HOURS_UTC.includes(cursor.getUTCHours())) {
      bars.push({
        instrument: symbol,
        timeframe: '1h',
        open_time: new Date(cursor),
        close_time: new Date(cursor.getTime() + 3_600_000),
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 1_000,
        source: 'raw-vendor',
      });
    }
    cursor = new Date(cursor.getTime() - 3_600_000);
  }

  return bars.reverse();
}

const ASOF = new Date('2026-08-14T20:00:00.000Z');

function recordingFetcher(): { fetch: BarFetcher; lookbacks: number[] } {
  const lookbacks: number[] = [];
  return {
    lookbacks,
    fetch: async (symbol, window, asOf) => {
      lookbacks.push(window.lookback);
      return extendedHoursBars(symbol, window.lookback, asOf);
    },
  };
}

function normalized(fetch: BarFetcher): BarFetcher {
  return withSessionNormalization({
    fetch,
    source: 'polygon',
    asset_class: 'stocks',
    calendar: new UsEquityRegularHoursCalendar(),
  });
}

describe('withSessionNormalization (#562)', () => {
  it('drops the vendor rows that fall outside a trading session', async () => {
    const { fetch } = recordingFetcher();

    const bars = await normalized(fetch)('SPY', { timeframe: '1h', lookback: 15 }, ASOF);

    expect(bars).not.toHaveLength(0);
    for (const bar of bars) {
      expect(REGULAR_HOURS_UTC).toContain(bar.open_time.getUTCHours());
    }
  });

  it('still serves the full lookback, by widening the raw ask', async () => {
    const { fetch, lookbacks } = recordingFetcher();

    const bars = await normalized(fetch)('SPY', { timeframe: '1h', lookback: 15 }, ASOF);

    expect(bars).toHaveLength(15);
    expect(lookbacks.length).toBeGreaterThan(1);
    expect(lookbacks[0]).toBe(16);
    expect(lookbacks[1]).toBeGreaterThan(16);
  });

  it('stamps every surviving bar with the configured vendor name', async () => {
    const { fetch } = recordingFetcher();

    const bars = await normalized(fetch)('SPY', { timeframe: '1h', lookback: 15 }, ASOF);

    expect(new Set(bars.map((bar) => bar.source))).toEqual(new Set(['polygon']));
  });

  it('is loud rather than short when nothing the vendor holds is in session', async () => {
    const fetch: BarFetcher = async (symbol, window, asOf) =>
      Array.from({ length: window.lookback }, (_, i) => {
        const open = new Date(asOf.getTime() - (i + 1) * 86_400_000);
        open.setUTCHours(3, 0, 0, 0);
        return {
          instrument: symbol,
          timeframe: window.timeframe,
          open_time: open,
          close_time: new Date(open.getTime() + 3_600_000),
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          volume: 1_000,
          source: 'raw-vendor',
        };
      });

    await expect(normalized(fetch)('SPY', { timeframe: '1h', lookback: 15 }, ASOF)).rejects.toThrow(
      InSessionUnderfetchError,
    );
  });

  it('returns a short serve without throwing when the vendor has run out of history', async () => {
    const fetch: BarFetcher = async (symbol) =>
      [15, 16].map((hour) => {
        const open = new Date(Date.UTC(2026, 7, 14, hour));
        return {
          instrument: symbol,
          timeframe: '1h',
          open_time: open,
          close_time: new Date(open.getTime() + 3_600_000),
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          volume: 1_000,
          source: 'raw-vendor',
        };
      });

    const bars = await normalized(fetch)('SPY', { timeframe: '1h', lookback: 15 }, ASOF);

    expect(bars).toHaveLength(2);
  });

  describe('request budget (#828)', () => {
    it('spends at most TWO raw fetches, however little survives normalization', async () => {
      let calls = 0;
      const fetch: BarFetcher = async (symbol, window, asOf) => {
        calls++;
        return Array.from({ length: window.lookback }, (_, i) => {
          const open = new Date(asOf.getTime() - (i + 1) * 86_400_000);
          open.setUTCHours(3, 0, 0, 0);
          return {
            instrument: symbol,
            timeframe: window.timeframe,
            open_time: open,
            close_time: new Date(open.getTime() + 3_600_000),
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            volume: 1_000,
            source: 'raw-vendor',
          };
        });
      };

      await expect(
        normalized(fetch)('SPY', { timeframe: '1h', lookback: 15 }, ASOF),
      ).rejects.toThrow(InSessionUnderfetchError);

      expect(calls).toBe(2);
    });

    it('makes its ONE retry the widest ask permitted, not an incremental estimate', async () => {
      const { fetch, lookbacks } = recordingFetcher();

      const bars = await normalized(fetch)('SPY', { timeframe: '1h', lookback: 15 }, ASOF);

      expect(lookbacks).toEqual([16, 512]);
      expect(bars).toHaveLength(15);
    });
  });
});
