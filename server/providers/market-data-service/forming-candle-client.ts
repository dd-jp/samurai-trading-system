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
