/**
 * Shared test fixture (issue #362 review). An `AlpacaMarketDataClient` whose `getBars`
 * genuinely tracks the requested `limit` — unlike this module's other test
 * doubles, which return a fixed array regardless of args. Generates exactly
 * `limit` sequential hourly candles ending at the CURRENT (forming) hour
 * relative to whatever `asOf` the call receives: the most recent one always
 * has `close_time > asOf`, so `completedBars` always drops exactly one of
 * them — the exact shape of the reported bug
 * (`sma(14) needs 14 bars but received 13`).
 *
 * Used by both `sources/sources.test.ts` (direct
 * `NormalizingDataSource.fetchBars` unit coverage) and
 * `ingestion-round-trip.test.ts` (the full `MarketDataServiceImpl` cold-start
 * regression, through a real empty store) — same generator, two different
 * assertions on top of it.
 */
import type { AlpacaBar, AlpacaMarketDataClient } from './sources/alpaca-source.js';

export function formingCandleClient(quoteAsOf: Date): AlpacaMarketDataClient {
  return {
    getBars: async (_symbol, _timeframe, asOf, limit): Promise<AlpacaBar[]> => {
      const hourFloor = new Date(asOf);
      hourFloor.setUTCMinutes(0, 0, 0);
      return Array.from({ length: limit }, (_, index) => {
        const i = limit - 1 - index;
        const openTime = new Date(hourFloor.getTime() - i * 3_600_000);
        return { t: openTime.toISOString(), o: 100, h: 101, l: 99, c: 100 + index, v: 10 };
      });
    },
    getLatestQuote: async () => ({ t: quoteAsOf.toISOString(), ap: 100, bp: 100 }),
  };
}
