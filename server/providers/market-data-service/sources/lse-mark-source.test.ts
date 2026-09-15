/**
 * `LseMarkDataSource` (#734).
 *
 * Every fixture below is a hand-written payload — no network call, in CI or
 * out of it. The numbers are shaped after the real payloads probed for
 * `docs/research/34-lse-mark-source-options.md` (LQQ3 in GBp at ~31,240 pence,
 * 3USL in USD), because the currency traps this class exists to refuse are
 * traps that the real venue actually sets.
 */
import { describe, expect, it } from 'vitest';
import { buildRoutingMap, LSE_ETP_POOL } from '../../universe-pool/index.js';
import {
  BOOK_CURRENCY,
  isBookCurrency,
  type LseMarkClient,
  LseMarkDataSource,
  type LseVendorBars,
  type LseVendorQuote,
  MarkCurrencyError,
  NonTradeableInstrumentError,
  toBookCurrency,
} from './lse-mark-source.js';

const TRADEABLE = new Set(buildRoutingMap().keys());
const SCREENING = new Set(LSE_ETP_POOL.map((row) => row.screening_instrument));

/** A minute inside an LSE session: 2026-08-18 is a Tuesday; 10:00 London = 09:00Z. */
const IN_SESSION = new Date('2026-08-18T09:00:00.000Z');

interface FakeClientOptions {
  quote?: LseVendorQuote;
  bars?: LseVendorBars;
  vendor?: string;
}

function fakeClient(options: FakeClientOptions = {}): LseMarkClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    vendor: options.vendor ?? 'fake-lse-vendor',
    calls,
    async getBars(symbol) {
      calls.push(`getBars:${symbol}`);
      return (
        options.bars ?? {
          currency: 'GBp',
          candles: [],
        }
      );
    },
    async getLatestQuote(symbol) {
      calls.push(`getLatestQuote:${symbol}`);
      return (
        options.quote ?? {
          price: 31_240,
          currency: 'GBp',
          observed_at: new Date('2026-08-18T08:59:30.000Z'),
        }
      );
    },
  };
}

function sourceWith(client: LseMarkClient): LseMarkDataSource {
  return new LseMarkDataSource(client, {
    tradeable: TRADEABLE,
    screeningInstruments: SCREENING,
  });
}

describe('toBookCurrency', () => {
  it('passes GBP through untouched', () => {
    expect(toBookCurrency(312.4, 'GBP', 'LQQ3', 'v')).toBe(312.4);
  });

  it.each(['GBX', 'gbx', 'GBp', 'p'])('divides %s by 100 — pence are a sub-unit', (code) => {
    expect(toBookCurrency(31_240, code, 'LQQ3', 'v')).toBeCloseTo(312.4, 10);
  });

  it("does not mistake 'GBp' for 'GBP' — the 100x trap", () => {
    // The whole reason pence are tested before pounds: these two codes differ
    // by one character's case and by a factor of 100.
    expect(toBookCurrency(100, 'GBp', 'LQQ3', 'v')).toBe(1);
    expect(toBookCurrency(100, 'GBP', 'LQQ3', 'v')).toBe(100);
  });

  it('refuses USD rather than inventing an FX rate', () => {
    expect(() => toBookCurrency(189.27, 'USD', '3USL', 'v')).toThrow(MarkCurrencyError);
    expect(() => toBookCurrency(189.27, 'USD', '3USL', 'v')).toThrow(
      /FX rate this system does not/,
    );
  });

  it('refuses EUR too — the refusal is not a USD special case', () => {
    expect(() => toBookCurrency(10, 'EUR', '3PRE', 'v')).toThrow(MarkCurrencyError);
  });

  it('tolerates surrounding whitespace in the vendor code', () => {
    expect(toBookCurrency(31_240, ' GBX ', 'LQQ3', 'v')).toBeCloseTo(312.4, 10);
  });
});

describe('LseMarkDataSource — the no-substitution invariant (#734 DoD)', () => {
  it.each([...SCREENING])(
    'refuses to serve a mark for screening instrument %s',
    async (screening) => {
      const client = fakeClient();
      const source = sourceWith(client);

      await expect(source.fetchMark(screening, IN_SESSION, 'live')).rejects.toThrow(
        NonTradeableInstrumentError,
      );
      // The refusal happens BEFORE any vendor call — nothing was even asked.
      expect(client.calls).toEqual([]);
    },
  );

  it('names the substitution in the refusal, not just "unknown symbol"', async () => {
    const source = sourceWith(fakeClient());
    await expect(source.fetchMark('SPY', IN_SESSION, 'live')).rejects.toThrow(
      /SCREENING INSTRUMENT/,
    );
  });

  /**
   * `production.ts`'s `benchmarkMarketDataStore` doc argues the two
   * `SqliteMarketDataStore` writers (the live universe path and the outside
   * benchmarks' own path) are disjoint on `'SPY'`/`'AGG'` rows ONLY because
   * this source refuses both instruments before any write can reach the
   * store. The benchmark path reads via `getDailyCloses`, which resolves to
   * `fetchRawCandles`/`fetchBars` — the BARS path, not the mark path — so the
   * invariant that actually protects the store must be pinned there, not
   * just on `fetchMark`. Pin both so a future pool/config change can't
   * silently reopen the collision the doc argues is closed.
   */
  it('refuses SPY and AGG on the mark path — the pair the outside-benchmark store-disjointness argument depends on', async () => {
    const source = sourceWith(fakeClient());
    await expect(source.fetchMark('SPY', IN_SESSION, 'live')).rejects.toThrow(
      NonTradeableInstrumentError,
    );
    await expect(source.fetchMark('AGG', IN_SESSION, 'live')).rejects.toThrow(
      NonTradeableInstrumentError,
    );
  });

  it('refuses SPY and AGG on the bars path — the one the store-disjointness argument actually depends on', async () => {
    const source = sourceWith(fakeClient());
    await expect(
      source.fetchBars('SPY', { timeframe: '1m', lookback: 5 }, IN_SESSION),
    ).rejects.toThrow(NonTradeableInstrumentError);
    await expect(
      source.fetchBars('AGG', { timeframe: '1m', lookback: 5 }, IN_SESSION),
    ).rejects.toThrow(NonTradeableInstrumentError);
  });

  it('refuses screening instruments on the bars and quote paths as well', async () => {
    const client = fakeClient();
    const source = sourceWith(client);

    await expect(
      source.fetchBars('SPY', { timeframe: '1m', lookback: 5 }, IN_SESSION),
    ).rejects.toThrow(NonTradeableInstrumentError);
    await expect(source.fetchQuote('SPY')).rejects.toThrow(NonTradeableInstrumentError);
    expect(client.calls).toEqual([]);
  });

  it('refuses an instrument that is neither an lse_ticker nor a screening instrument', async () => {
    const source = sourceWith(fakeClient());
    await expect(source.fetchMark('BTC-USD', IN_SESSION, 'live')).rejects.toThrow(
      /not an lse_ticker in the LSE ETP pool/,
    );
  });

  it('serves every lse_ticker in the checked-in pool', async () => {
    const source = sourceWith(fakeClient());
    for (const row of LSE_ETP_POOL) {
      const mark = await source.fetchMark(row.lse_ticker, IN_SESSION, 'live');
      expect(mark.price).toBeGreaterThan(0);
    }
  });

  it('refuses construction for a pool row whose DECLARED currency is not GBP', () => {
    // The check that a uniform fake cannot make: each row's own declared
    // currency, straight off the checked-in pool. Eight of the eleven declare
    // USD (doc 34 §3.2), so a source built over the whole pool must refuse —
    // and must refuse HERE, not on the first live read.
    const declared = new Map(LSE_ETP_POOL.map((row) => [row.lse_ticker, row.currency]));
    expect(
      () =>
        new LseMarkDataSource(fakeClient(), { tradeable: TRADEABLE, declaredCurrencies: declared }),
    ).toThrow(/3USL \(USD\)/);
  });

  it('constructs over the subset the pool declares in GBP or pence', () => {
    const markable = new Map(
      LSE_ETP_POOL.filter((row) => isBookCurrency(row.currency)).map((row) => [
        row.lse_ticker,
        row.currency,
      ]),
    );
    // If this is ever empty the pool has no markable line at all, which is a
    // louder finding than a failing assertion.
    expect(markable.size).toBeGreaterThan(0);
    expect(
      () =>
        new LseMarkDataSource(fakeClient(), {
          tradeable: TRADEABLE,
          declaredCurrencies: markable,
        }),
    ).not.toThrow();
  });

  it('refuses to be constructed with an empty allow-list', () => {
    expect(() => new LseMarkDataSource(fakeClient(), { tradeable: new Set() })).toThrow(
      /empty tradeable set/,
    );
  });
});

describe('LseMarkDataSource — marks', () => {
  it('converts a pence quote into GBP and keeps the vendor observation time', async () => {
    const observed = new Date('2026-08-18T08:59:30.000Z');
    const source = sourceWith(
      fakeClient({ quote: { price: 31_240, currency: 'GBp', observed_at: observed } }),
    );

    const mark = await source.fetchMark('LQQ3', IN_SESSION, 'live');

    expect(mark.price).toBeCloseTo(312.4, 10);
    // observed_at is the VENDOR's stamp, not the request time — this is the
    // field #641 and #640 gate on.
    expect(mark.observed_at).toEqual(observed);
    expect(mark.asset_class).toBe('stocks');
    expect(mark.source).toBe('fake-lse-vendor');
  });

  it('prefers the quote midpoint over the vendor last-trade price', async () => {
    const source = sourceWith(
      fakeClient({
        quote: {
          price: 300, // a stale last trade
          bid: 310,
          ask: 314,
          currency: 'GBP',
          observed_at: IN_SESSION,
        },
      }),
    );

    const mark = await source.fetchMark('LQQ3', IN_SESSION, 'live');
    expect(mark.price).toBe(312);
  });

  it('falls back to the vendor price when only one side of the book is quoted', async () => {
    const source = sourceWith(
      fakeClient({
        quote: { price: 300, bid: 299, currency: 'GBP', observed_at: IN_SESSION },
      }),
    );
    expect((await source.fetchMark('LQQ3', IN_SESSION, 'live')).price).toBe(300);
  });

  it('refuses a USD-quoted line rather than serving dollars into a GBP book', async () => {
    const source = sourceWith(
      fakeClient({ quote: { price: 189.27, currency: 'USD', observed_at: IN_SESSION } }),
    );
    await expect(source.fetchMark('3USL', IN_SESSION, 'live')).rejects.toThrow(MarkCurrencyError);
  });

  it(`emits marks denominated in ${BOOK_CURRENCY}`, () => {
    expect(BOOK_CURRENCY).toBe('GBP');
  });
});

describe('LseMarkDataSource — quotes', () => {
  it('converts both sides of a pence book', async () => {
    const source = sourceWith(
      fakeClient({
        quote: {
          price: 31_240,
          bid: 31_200,
          ask: 31_280,
          currency: 'GBp',
          observed_at: IN_SESSION,
        },
      }),
    );

    const quote = await source.fetchQuote('LQQ3');
    expect(quote).not.toBeNull();
    expect(quote?.bid).toBeCloseTo(312.0, 10);
    expect(quote?.ask).toBeCloseTo(312.8, 10);
    expect(quote?.observed_at).toEqual(IN_SESSION);
  });

  it('answers null — not a throw — when the vendor has no book', async () => {
    const source = sourceWith(fakeClient());
    expect(await source.fetchQuote('LQQ3')).toBeNull();
  });
});

describe('LseMarkDataSource — bars', () => {
  it('normalizes pence bars to GBP and leaves volume alone', async () => {
    const source = sourceWith(
      fakeClient({
        bars: {
          currency: 'GBp',
          candles: [
            {
              open_time: new Date('2026-08-18T08:00:00.000Z'),
              open: 31_200,
              high: 31_300,
              low: 31_100,
              close: 31_240,
              volume: 4_200,
            },
          ],
        },
      }),
    );

    const bars = await source.fetchBars(
      'LQQ3',
      { timeframe: '1m', lookback: 1, partial: 'allow' },
      IN_SESSION,
    );

    expect(bars).toHaveLength(1);
    expect(bars[0]?.open).toBeCloseTo(312.0, 10);
    expect(bars[0]?.close).toBeCloseTo(312.4, 10);
    // Volume is a share count, not a price. Converting it would be wrong.
    expect(bars[0]?.volume).toBe(4_200);
  });

  it('gates bars on the LSE session, not the US one', async () => {
    // 13:00 London (12:00Z) is inside the LSE session; a 07:00Z candle is
    // BEFORE the 08:00 London open and must be dropped by normalization. The
    // US calendar would keep neither/both differently — that is the bug this
    // guards.
    const source = sourceWith(
      fakeClient({
        bars: {
          currency: 'GBP',
          candles: [
            {
              open_time: new Date('2026-08-18T06:00:00.000Z'),
              open: 1,
              high: 1,
              low: 1,
              close: 1,
              volume: 1,
            },
            {
              open_time: new Date('2026-08-18T09:00:00.000Z'),
              open: 2,
              high: 2,
              low: 2,
              close: 2,
              volume: 2,
            },
          ],
        },
      }),
    );

    const bars = await source.fetchBars(
      'LQQ3',
      { timeframe: '1m', lookback: 5, partial: 'allow' },
      new Date('2026-08-18T12:00:00.000Z'),
    );

    expect(bars.map((bar) => bar.close)).toEqual([2]);
  });
});
