/**
 * The in-session bar-count guarantee (issue #386) — see
 * `NormalizingDataSource.fetchBars` for why the count has to be enforced
 * after normalization rather than on the raw wire payload, and for the live
 * measurement that says so.
 *
 * These tests pin the fix where the calendar is actually known: the raw
 * request is widened and re-issued until the COMPLETED, IN-SESSION count
 * satisfies the caller, or the bounds are exhausted and it throws loudly.
 *
 * Note what fixtures alone could NOT have caught here: this bug was invisible
 * to the whole suite precisely because fixture bars carry no pre/post-market
 * hours, so raw count and normalized count were always equal. The stub below
 * supplies a 24h-a-day feed for that reason.
 */

import type { TradingCalendar } from '../trading-calendar.js';
import { UsEquityRegularHoursCalendar } from '../trading-calendar.js';
import { type AlpacaBar, AlpacaDataSource, type AlpacaMarketDataClient } from './alpaca-source.js';
import { InSessionUnderfetchError, RawFetchLimitExceededError } from './normalizing-data-source.js';

const HOUR_MS = 3_600_000;

/** Sunday night, US equity session shut — the exact condition #386 was measured under */
const SESSION_SHUT = new Date('2026-07-19T23:00:00Z');
/** Wednesday 14:00 ET, mid-session */
const MID_SESSION = new Date('2026-07-15T18:00:00Z');

/**
 * `limit` consecutive hourly candles ending at the last whole hour at or
 * before `asOf` — a 24h-a-day feed, like the pre/post-market bars IEX serves
 * for equities and like a 24/7 crypto venue. Whether a candle survives is
 * therefore entirely the calendar's decision, which is the point.
 */
function hourlyCandles(asOf: Date, limit: number): AlpacaBar[] {
  const lastOpen = Math.floor(asOf.getTime() / HOUR_MS) * HOUR_MS;
  return Array.from({ length: limit }, (_, index) => ({
    t: new Date(lastOpen - (limit - 1 - index) * HOUR_MS).toISOString(),
    o: 1,
    h: 2,
    l: 0.5,
    c: 1.5,
    v: 10,
  }));
}

/**
 * Records every `limit` the source asked for. `supply` decides what comes
 * back, so a test can model a full feed, a scarce one, or one whose bars are
 * all out of session.
 */
function recordingClient(supply: (limit: number) => AlpacaBar[]): {
  client: AlpacaMarketDataClient;
  limits: number[];
} {
  const limits: number[] = [];
  const client: AlpacaMarketDataClient = {
    getBars: async (_symbol, _timeframe, _asOf, limit) => {
      limits.push(limit);
      return supply(limit);
    },
    getLatestQuote: async () => ({ t: SESSION_SHUT.toISOString(), ap: 1, bp: 1 }),
  };
  return { client, limits };
}

const NEVER_OPEN: TradingCalendar = {
  isOpen: () => false,
  isTradingDay: () => false,
  sessionStart: (instant) => instant,
  sessionEnd: () => null,
};

describe('the in-session bar count is what the guarantee is enforced on (#386)', () => {
  it('serves the full lookback of in-session bars while the equity session is shut', async () => {
    const { client, limits } = recordingClient((limit) => hourlyCandles(SESSION_SHUT, limit));
    const source = new AlpacaDataSource(client, {
      asset_class: 'stocks',
      calendar: new UsEquityRegularHoursCalendar(),
    });

    const bars = await source.fetchBars('SPY', { timeframe: '1h', lookback: 15 }, SESSION_SHUT);

    // Pre-fix this returned 12 — the raw guard was satisfied by out-of-session
    // bars that normalization then discarded
    expect(bars).toHaveLength(15);
    expect(limits.length).toBeGreaterThan(1);
  });

  it('returns bars that are all in session and all complete at asOf, not merely the right count', async () => {
    const calendar = new UsEquityRegularHoursCalendar();
    const { client } = recordingClient((limit) => hourlyCandles(SESSION_SHUT, limit));
    const source = new AlpacaDataSource(client, { asset_class: 'stocks', calendar });

    const bars = await source.fetchBars('SPY', { timeframe: '1h', lookback: 15 }, SESSION_SHUT);

    expect(bars.every((bar) => calendar.isOpen(bar.open_time))).toBe(true);
    expect(bars.every((bar) => bar.close_time.getTime() <= SESSION_SHUT.getTime())).toBe(true);
  });

  it('widens the raw request rather than re-issuing the same one', async () => {
    const { client, limits } = recordingClient((limit) => hourlyCandles(SESSION_SHUT, limit));
    const source = new AlpacaDataSource(client, {
      asset_class: 'stocks',
      calendar: new UsEquityRegularHoursCalendar(),
    });

    await source.fetchBars('SPY', { timeframe: '1h', lookback: 15 }, SESSION_SHUT);

    // First ask is still `lookback + FORMING_BAR_FETCH_MARGIN` (#362) — the
    // widening is a response to a measured shortfall, not a standing buffer
    expect(limits[0]).toBe(16);
    for (let i = 1; i < limits.length; i++) {
      expect(limits[i]).toBeGreaterThan(limits[i - 1] as number);
    }
  });

  it('serves mid-session equity reads too, where a naive window holds only today’s few bars', async () => {
    const { client } = recordingClient((limit) => hourlyCandles(MID_SESSION, limit));
    const source = new AlpacaDataSource(client, {
      asset_class: 'stocks',
      calendar: new UsEquityRegularHoursCalendar(),
    });

    const bars = await source.fetchBars('SPY', { timeframe: '1h', lookback: 15 }, MID_SESSION);

    expect(bars).toHaveLength(15);
  });
});

describe('crypto is untouched: raw count equals normalized count', () => {
  it('costs exactly one request and returns the lookback under an always-open calendar', async () => {
    const { client, limits } = recordingClient((limit) => hourlyCandles(SESSION_SHUT, limit));
    const source = new AlpacaDataSource(client, { asset_class: 'crypto' });

    const bars = await source.fetchBars('BTC-USD', { timeframe: '1h', lookback: 15 }, SESSION_SHUT);

    expect(bars).toHaveLength(15);
    expect(limits).toEqual([16]);
  });

  it('does not widen for crypto even at the same asOf that forces four equity attempts', async () => {
    const supply = (limit: number) => hourlyCandles(SESSION_SHUT, limit);
    const crypto = recordingClient(supply);
    const stocks = recordingClient(supply);

    await new AlpacaDataSource(crypto.client, { asset_class: 'crypto' }).fetchBars(
      'ETH-USD',
      { timeframe: '1h', lookback: 30 },
      SESSION_SHUT,
    );
    await new AlpacaDataSource(stocks.client, {
      asset_class: 'stocks',
      calendar: new UsEquityRegularHoursCalendar(),
    }).fetchBars('SPY', { timeframe: '1h', lookback: 30 }, SESSION_SHUT);

    expect(crypto.limits).toHaveLength(1);
    expect(stocks.limits.length).toBeGreaterThan(1);
  });
});

describe('the widen targets the count the caller asked for, not one more', () => {
  /**
   * Admits one UTC hour in five, so the survival rate lands in the band where
   * the ESTIMATE is the binding term — between the 2x floor and the 8x cap.
   * Outside that band the clamps swallow an off-by-margin and it is invisible.
   */
  const ONE_HOUR_IN_FIVE: TradingCalendar = {
    isOpen: (instant) => instant.getUTCHours() % 5 === 0,
    isTradingDay: () => true,
    sessionStart: (instant) => instant,
    sessionEnd: () => null,
  };

  it('sizes the widen off window.lookback, not lookback + FORMING_BAR_FETCH_MARGIN', async () => {
    const { client, limits } = recordingClient((limit) => hourlyCandles(SESSION_SHUT, limit));
    const source = new AlpacaDataSource(client, {
      asset_class: 'stocks',
      calendar: ONE_HOUR_IN_FIVE,
    });

    const bars = await source.fetchBars('SPY', { timeframe: '1h', lookback: 15 }, SESSION_SHUT);

    // 3 of the first 16 raw candles survive, so the rate is 3/16 and the
    // estimate is ceil(15 / 0.1875) = 80. Targeting `lookback + 1` instead
    // gives ceil(16 / 0.1875) = 86 — six raw candles nobody asked for
    //
    // Asserted on the REQUEST SIZE, deliberately: both values satisfy the
    // caller at attempt 2, so a test that only checked `bars` would pass
    // either way and pin nothing
    expect(limits).toEqual([16, 80]);
    expect(bars).toHaveLength(15);
  });
});

describe('the retry is bounded, and exhaustion is loud', () => {
  it('stops at the raw-limit ceiling when no bar is ever in session, and throws', async () => {
    const { client, limits } = recordingClient((limit) => hourlyCandles(SESSION_SHUT, limit));
    const source = new AlpacaDataSource(client, {
      asset_class: 'stocks',
      calendar: NEVER_OPEN,
    });

    await expect(
      source.fetchBars('SPY', { timeframe: '1h', lookback: 15 }, SESSION_SHUT),
    ).rejects.toThrow(InSessionUnderfetchError);

    // 16 -> 128 -> 512, where 512 is the ceiling (32x the first ask). Pinned
    // exactly: an unbounded widen against a live venue burns the ~200 req/min
    // budget shared with live order placement
    expect(limits).toEqual([16, 128, 512]);
  });

  it('stops at the attempt cap when a trickle of in-session bars keeps the estimate small, and throws', async () => {
    // Only the ten most recent candles are ever in session — a shape that
    // makes each widen look nearly sufficient, so the growth estimate stays
    // small and the ATTEMPT bound (not the ceiling) is what stops it
    const inSessionFrom = SESSION_SHUT.getTime() - 10 * HOUR_MS;
    const trickle: TradingCalendar = {
      isOpen: (instant) => instant.getTime() > inSessionFrom,
      isTradingDay: () => true,
      sessionStart: (instant) => instant,
      sessionEnd: () => null,
    };
    const { client, limits } = recordingClient((limit) => hourlyCandles(SESSION_SHUT, limit));
    const source = new AlpacaDataSource(client, { asset_class: 'stocks', calendar: trickle });

    await expect(
      source.fetchBars('SPY', { timeframe: '1h', lookback: 15 }, SESSION_SHUT),
    ).rejects.toThrow(InSessionUnderfetchError);

    // Four attempts, well short of the 512 ceiling — the attempt cap binds here
    expect(limits).toEqual([16, 32, 64, 128]);
  });

  it('carries the numbers an operator needs, and never returns a short window instead', async () => {
    const { client } = recordingClient((limit) => hourlyCandles(SESSION_SHUT, limit));
    const source = new AlpacaDataSource(client, { asset_class: 'stocks', calendar: NEVER_OPEN });

    const error = await source
      .fetchBars('SPY', { timeframe: '1h', lookback: 15 }, SESSION_SHUT)
      .then(
        (bars) => bars,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(InSessionUnderfetchError);
    const underfetch = error as InSessionUnderfetchError;
    expect(underfetch.instrument).toBe('SPY');
    expect(underfetch.timeframe).toBe('1h');
    expect(underfetch.requested).toBe(15);
    expect(underfetch.received).toBe(0);
    expect(underfetch.attempts).toBe(3);
    expect(underfetch.message).toContain('SPY');
  });
});

describe('the absolute raw-row cap (#747)', () => {
  it('clamps the widen ceiling below the 32x multiple once the multiple would exceed 20,000 rows', async () => {
    // firstRawLimit = 701 (700 + FORMING_BAR_FETCH_MARGIN). 701*32 = 22,432 —
    // above MAX_RAW_LIMIT_ABSOLUTE (20,000) — so the ceiling this widen is
    // bounded by is the absolute cap, not the multiple. A ten-prior-session
    // 5m RVOL lookback is exactly this shape (issue #747)
    const { client, limits } = recordingClient((limit) => hourlyCandles(SESSION_SHUT, limit));
    const source = new AlpacaDataSource(client, { asset_class: 'stocks', calendar: NEVER_OPEN });

    await expect(
      source.fetchBars('SPY', { timeframe: '1h', lookback: 700 }, SESSION_SHUT),
    ).rejects.toThrow(InSessionUnderfetchError);

    // 701 -> 5,608 (8x, nothing survived) -> 20,000 (would-be 44,864 clamped
    // to the absolute cap) -> widen(20,000) also clamps to 20,000, which is
    // <= the current rawLimit, so the loop stops there rather than issuing a
    // fourth, identical request
    expect(limits).toEqual([701, 5608, 20000]);
    expect(Math.max(...limits)).toBeLessThanOrEqual(20_000);
  });

  it('fails loud, before any fetch, when the caller’s own first ask already exceeds the absolute cap', async () => {
    const { client, limits } = recordingClient((limit) => hourlyCandles(SESSION_SHUT, limit));
    const source = new AlpacaDataSource(client, {
      asset_class: 'stocks',
      calendar: new UsEquityRegularHoursCalendar(),
    });

    // lookback 20,000 + FORMING_BAR_FETCH_MARGIN (1) = 20,001 > 20,000
    await expect(
      source.fetchBars('SPY', { timeframe: '5m', lookback: 20_000 }, MID_SESSION),
    ).rejects.toThrow(RawFetchLimitExceededError);

    // Refused before any request reached the client — never an unbounded
    // fetch, never a silently truncated one
    expect(limits).toEqual([]);
  });

  it('names the instrument, timeframe, and both limits on the thrown error', async () => {
    const { client } = recordingClient((limit) => hourlyCandles(SESSION_SHUT, limit));
    const source = new AlpacaDataSource(client, {
      asset_class: 'stocks',
      calendar: new UsEquityRegularHoursCalendar(),
    });

    const error = await source
      .fetchBars('SPY', { timeframe: '5m', lookback: 25_000 }, MID_SESSION)
      .then(
        (bars) => bars,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(RawFetchLimitExceededError);
    const capped = error as RawFetchLimitExceededError;
    expect(capped.instrument).toBe('SPY');
    expect(capped.timeframe).toBe('5m');
    expect(capped.requestedRawLimit).toBe(25_001);
    expect(capped.absoluteLimit).toBe(20_000);
  });
});

describe("the source's own short-read policy still owns raw scarcity (#292)", () => {
  it("does not widen or throw when partial: 'allow' — an opted-in caller costs one request", async () => {
    const { client, limits } = recordingClient((limit) => hourlyCandles(SESSION_SHUT, limit));
    const source = new AlpacaDataSource(client, { asset_class: 'stocks', calendar: NEVER_OPEN });

    const bars = await source.fetchBars(
      'SPY',
      { timeframe: '1h', lookback: 15, partial: 'allow' },
      SESSION_SHUT,
    );

    expect(bars).toEqual([]);
    expect(limits).toEqual([16]);
  });

  it('does not widen when the source returns fewer RAW candles than asked — that is the client’s AlpacaDataUnderfetchError to raise, not a normalization loss', async () => {
    // Three raw candles for a 16-bar ask: the venue has no more history
    // Widening cannot conjure bars that do not exist, and the real client
    // already fails loudly on this path (AlpacaDataUnderfetchError) before we
    // ever see it. Two of the three complete at `asOf`; the newest is forming.
    const { client, limits } = recordingClient(() => hourlyCandles(MID_SESSION, 3));
    const source = new AlpacaDataSource(client, {
      asset_class: 'stocks',
      calendar: new UsEquityRegularHoursCalendar(),
    });

    const bars = await source.fetchBars('AAPL', { timeframe: '1h', lookback: 15 }, MID_SESSION);

    expect(bars).toHaveLength(2);
    expect(limits).toEqual([16]);
  });

  it('does not throw InSessionUnderfetchError for a sparse 24/7 symbol, where normalization dropped nothing', async () => {
    // The case that settles it. Under `AlwaysOpenCalendar` every raw candle
    // survives, so a short serve is purely the venue's missing history —
    // throwing here would report "the missing bars fell outside a trading
    // session" about an instrument that has no sessions, which is the #358
    // misattribution pointed the other way. Raw scarcity keeps its own,
    // correctly-named errors one layer up
    const { client } = recordingClient(() => hourlyCandles(SESSION_SHUT, 5));
    const source = new AlpacaDataSource(client, { asset_class: 'crypto' });

    const bars = await source.fetchBars('BTC-USD', { timeframe: '1h', lookback: 14 }, SESSION_SHUT);

    expect(bars).toHaveLength(4);
  });
});
