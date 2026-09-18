import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../shared/index.js';
import { MarketIntelligenceStore } from '../index.js';
import { CURATED_MACRO_MARKETS } from './curated-markets.js';
import { POLYMARKET_ASSET_CLASS, PolymarketAgent } from './polymarket-agent.js';
import type { PolymarketMarket, PolymarketPricePoint } from './polymarket-client.js';

const NOW = new Date('2026-09-05T15:00:00Z');
const clock: Clock = { now: () => NOW };

const LIVE_SNAPSHOTS: Record<
  string,
  { outcomePrices: [number, number]; volume24hr: number; liquidity: number }
> = {
  'will-the-fed-increase-interest-rates-by-25-bps-after-the-september-2026-meeting-649': {
    outcomePrices: [0.495, 0.505],
    volume24hr: 371_097.75,
    liquidity: 761_280.28,
  },
  'will-the-fed-increase-interest-rates-by-25-bps-after-the-october-2026-meeting-20260617190324032':
    {
      outcomePrices: [0.275, 0.725],
      volume24hr: 12_038.3,
      liquidity: 277_452.13,
    },
  'will-the-fed-increase-interest-rates-by-25-bps-after-the-december-2026-meeting-20260729232808636':
    {
      outcomePrices: [0.44, 0.56],
      volume24hr: 141.89,
      liquidity: 279_924.11,
    },
  'will-the-fed-increase-interest-rates-by-25-bps-after-the-january-2027-meeting-20260729233815506':
    {
      outcomePrices: [0.245, 0.755],
      volume24hr: 146.33,
      liquidity: 31_661.47,
    },
  'russia-x-ukraine-ceasefire-agreement-by-december-31-2026': {
    outcomePrices: [0.265, 0.735],
    volume24hr: 219_231.75,
    liquidity: 116_303.18,
  },
  'strait-of-hormuz-traffic-returns-to-normal-by-december-31': {
    outcomePrices: [0.265, 0.735],
    volume24hr: 40_236.94,
    liquidity: 432_446.45,
  },
};

function history(from: number, to: number): PolymarketPricePoint[] {
  const points: PolymarketPricePoint[] = [];
  for (let index = 0; index <= 24; index += 1) {
    const at = new Date(NOW.getTime() - (24 - index) * 60 * 60 * 1000);
    points.push({ at, probability: from + ((to - from) * index) / 24 });
  }
  return points;
}

describe('CURATED_MACRO_MARKETS (#1120)', () => {
  it('does not carry either row #1120 replaced', () => {
    const ids = CURATED_MACRO_MARKETS.map((entry) => entry.id);
    expect(ids).not.toContain('us-recession-2026');
    expect(ids).not.toContain('us-recession-2027');
  });

  it('has a live snapshot fixture for every shipped row, one for one', () => {
    const marketSlugs = CURATED_MACRO_MARKETS.map((entry) => entry.marketSlug);
    expect(Object.keys(LIVE_SNAPSHOTS).sort()).toEqual([...marketSlugs].sort());
  });

  it('produces a scored item for every curated row against a live snapshot', async () => {
    const store = new MarketIntelligenceStore(clock);
    const agent = new PolymarketAgent({
      client: {
        fetchEventMarket: async (
          _eventSlug: string,
          marketSlug: string,
        ): Promise<PolymarketMarket | undefined> => {
          const snapshot = LIVE_SNAPSHOTS[marketSlug];
          if (snapshot === undefined) return undefined;
          return {
            slug: marketSlug,
            question: marketSlug,
            outcomes: ['Yes', 'No'],
            outcomePrices: snapshot.outcomePrices,
            tokenIds: ['token-yes', 'token-no'],
            bestBid: snapshot.outcomePrices[0] - 0.005,
            bestAsk: snapshot.outcomePrices[0] + 0.005,
            spread: 0.01,
            volume24hr: snapshot.volume24hr,
            liquidity: snapshot.liquidity,
            updatedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
            closed: false,
            payload: `{"slug":"${marketSlug}"}`,
          };
        },
        fetchPriceHistory: async () => history(0.3, 0.5),
      },
      store,
      clock,
    });

    await expect(agent.refresh('t1')).resolves.toBe(true);

    const intel = store.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'test').intel;
    expect(intel.map((item) => item.entity).sort()).toEqual(
      CURATED_MACRO_MARKETS.map((entry) => entry.entity).sort(),
    );
  });
});
