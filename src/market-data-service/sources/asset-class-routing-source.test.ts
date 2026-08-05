/**
 * `AssetClassRoutingDataSource` (#381) — the seam that lets a mixed universe
 * reach two different Alpaca API roots.
 *
 * The failure being guarded against is #358's: equities served from the crypto
 * path root 404 on every call, which surfaces upstream as a reasonless
 * `quorum_skip` rather than as an error. So the assertions here are about
 * WHICH delegate was called, not about what came back — a test that only
 * checked return values would pass with both instruments routed to one source.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AssetClass } from '../../shared/index.js';
import type { Bar, BarWindow, DataSource, Mark, Quote } from '../types.js';
import { AssetClassRoutingDataSource } from './asset-class-routing-source.js';

const ASOF = new Date('2026-08-04T15:00:00Z');
const WINDOW: BarWindow = { timeframe: '1d', lookback: 30 };

function makeSource(assetClass: AssetClass, options: { quotes?: boolean } = {}): DataSource {
  const mark: Mark = {
    price: 1,
    observed_at: ASOF,
    source: assetClass,
    asset_class: assetClass,
  };
  const source: DataSource = {
    fetchBars: vi.fn(async (): Promise<Bar[]> => []),
    fetchMark: vi.fn(async (): Promise<Mark> => mark),
  };
  if (options.quotes === true) {
    source.fetchQuote = vi.fn(
      async (): Promise<Quote | null> => ({
        bid: 1,
        ask: 2,
        observed_at: ASOF,
      }),
    );
  }
  return source;
}

function makeRouter(sources: { crypto: DataSource; stocks: DataSource }) {
  return new AssetClassRoutingDataSource({
    sources,
    assetClassOf: new Map<string, AssetClass>([
      ['AAPL', 'stocks'],
      ['BTC-USD', 'crypto'],
    ]),
  });
}

describe('AssetClassRoutingDataSource', () => {
  it('sends each instrument to the source for its own asset class', async () => {
    const crypto = makeSource('crypto');
    const stocks = makeSource('stocks');
    const router = makeRouter({ crypto, stocks });

    await router.fetchBars('AAPL', WINDOW, ASOF);
    await router.fetchMark('BTC-USD', ASOF, 'live');

    expect(stocks.fetchBars).toHaveBeenCalledWith('AAPL', WINDOW, ASOF);
    expect(crypto.fetchBars).not.toHaveBeenCalled();
    expect(crypto.fetchMark).toHaveBeenCalledWith('BTC-USD', ASOF, 'live');
    expect(stocks.fetchMark).not.toHaveBeenCalled();
  });

  it('throws on an instrument with no configured asset class rather than guessing', async () => {
    const router = makeRouter({ crypto: makeSource('crypto'), stocks: makeSource('stocks') });

    // A default would be the silent version of #358: the symbol resolves to
    // *some* venue and returns a plausible empty result. Loud is the point.
    await expect(router.fetchMark('NVDA', ASOF, 'live')).rejects.toThrow(/no asset class/);
    await expect(router.fetchBars('NVDA', WINDOW, ASOF)).rejects.toThrow(/NVDA/);
  });

  it('forwards fetchQuote to the routed source when it quotes', async () => {
    const crypto = makeSource('crypto', { quotes: true });
    const stocks = makeSource('stocks');
    const router = makeRouter({ crypto, stocks });

    expect(await router.fetchQuote('BTC-USD', ASOF)).toEqual({
      bid: 1,
      ask: 2,
      observed_at: ASOF,
    });
  });

  it('answers null — not a throw — when the routed source cannot quote', async () => {
    // `fetchQuote` is optional on the port, and `getSpreadEstimate` already
    // treats "no quote" as `null` (MDS never fabricates a spread it cannot
    // observe). Throwing here would turn a documented absence into a tick
    // failure.
    const router = makeRouter({ crypto: makeSource('crypto'), stocks: makeSource('stocks') });

    expect(await router.fetchQuote('AAPL', ASOF)).toBeNull();
  });
});
