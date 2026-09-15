import { describe, expect, it } from 'vitest';
import { UsEquityRegularHoursCalendar } from '../trading-calendar.js';
import type { Bar } from '../types.js';
import { InSessionUnderfetchError } from './normalizing-data-source.js';
import type { BarFetcher } from './ohlcv-failover.js';
import { withSessionNormalization } from './session-normalized-fetcher.js';

/**
 * The fallback vendor's real shape, as measured in
 * `docs/research/31-free-ohlcv-evidence.md`: Polygon serves ~16 `1h`
 * aggregates per trading day, spanning 08:00Z-23:00Z, i.e. INCLUDING the
 * pre/post-market sessions the primary's calendar drops. That is exactly the
 * payload that must not reach the store unfiltered.
 */
const EXTENDED_HOURS_UTC = Array.from({ length: 16 }, (_, i) => 8 + i);

/** Regular US hours in August (EDT): 13:30Z-20:00Z, so hourly opens 14:00Z..19:00Z are in session */
const REGULAR_HOURS_UTC = [14, 15, 16, 17, 18, 19];

function isWeekday(date: Date): boolean {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}

/**
 * `limit` hourly candles ending at `asOf`, walking back through an
 * extended-hours weekday grid — the vendor's own coverage, unfiltered
 */
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
        // Deliberately a DIFFERENT vendor name than the one configured below:
        // the wrapper re-derives provenance from its own context, so a vendor
        // client cannot smuggle a second convention past it
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

    // The invariant: identical session semantics to the primary's, which is a
    // `NormalizingDataSource` over the same calendar. Nothing pre/post-market
    // survives, so an ATR over this window measures regular sessions
    expect(bars).not.toHaveLength(0);
    for (const bar of bars) {
      expect(REGULAR_HOURS_UTC).toContain(bar.open_time.getUTCHours());
    }
  });

  it('still serves the full lookback, by widening the raw ask', async () => {
    const { fetch, lookbacks } = recordingFetcher();

    const bars = await normalized(fetch)('SPY', { timeframe: '1h', lookback: 15 }, ASOF);

    // Filtering alone would have returned ~6 bars — one regular session's
    // worth — and every indicator over the window would have thrown
    expect(bars).toHaveLength(15);
    expect(lookbacks.length).toBeGreaterThan(1);
    expect(lookbacks[0]).toBe(16); // lookback + FORMING_BAR_FETCH_MARGIN
    expect(lookbacks[1]).toBeGreaterThan(16);
  });

  it('stamps every surviving bar with the configured vendor name', async () => {
    const { fetch } = recordingFetcher();

    const bars = await normalized(fetch)('SPY', { timeframe: '1h', lookback: 15 }, ASOF);

    expect(new Set(bars.map((bar) => bar.source))).toEqual(new Set(['polygon']));
  });

  it('is loud rather than short when nothing the vendor holds is in session', async () => {
    // Every candle at 03:00Z — never a US regular-hours open, at any widen
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
    // Raw scarcity, not session loss: two in-session candles and no more
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
      // The amplification #828 is about, counted at the vendor boundary: the
      // fallback is paced at one request per 13 seconds against Polygon's
      // documented 5/min free tier, and `PolygonBarsClient.getBars` issues
      // exactly one HTTP request per call, so an attempt IS a request. Under
      // the primary's `MAX_IN_SESSION_FETCH_ATTEMPTS` this read cost 4 of
      // them — ~39s of blocking per instrument per tick, serialized across
      // the universe, for as long as the primary stall lasts
      //
      // The pathological input: every candle at 03:00Z, never a US
      // regular-hours open, so no widen can ever satisfy the window. Widening
      // is exhausted rather than short-circuited, which is what makes the
      // count here the WORST case and not a lucky one
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

      // Loud, and cheap: the budget is spent, not the vendor's whole minute
      expect(calls).toBe(2);
    });

    it('makes its ONE retry the widest ask permitted, not an incremental estimate', async () => {
      // Why two requests dominate four rather than merely truncating them
      // The gradual walk sizes each step from the survival rate the previous
      // one revealed, so it converges on the ceiling over several requests;
      // the fallback jumps there on its only retry. `rawLimitCeiling` is
      // `firstRawLimit * MAX_RAW_LIMIT_MULTIPLE` = 16 * 32 = 512 here, which
      // is the widest ask ANY gradual sequence could have reached — so the
      // second request asks a question at least as good as the fourth would
      // have, and the serve rate does not pay for the smaller budget
      const { fetch, lookbacks } = recordingFetcher();

      const bars = await normalized(fetch)('SPY', { timeframe: '1h', lookback: 15 }, ASOF);

      expect(lookbacks).toEqual([16, 512]);
      expect(bars).toHaveLength(15);
    });
  });
});
