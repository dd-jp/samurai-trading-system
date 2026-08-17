/**
 * `FailoverDataSource` (#562) — the `DataSource`-port half of #496's
 * failover, the half the live orchestrator can actually inject.
 *
 * The composition-root half (that `buildProductionOrchestrator` really
 * constructs one of these, rather than this class existing with no caller)
 * is asserted in `server/apps/orchestrator/production.test.ts` — deliberately
 * there and not here: a wrapper that works in isolation and is never wired is
 * this repo's documented dominant defect class.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Bar, DataSource, Mark, Quote } from '../types.js';
import { FailoverDataSource } from './failover-data-source.js';
import type { FailoverEvent } from './ohlcv-failover.js';

const ASOF = new Date('2026-08-17T14:00:00.000Z');
const WINDOW = { timeframe: '1h', lookback: 2 } as const;

function barFrom(source: string, instrument = 'SPY'): Bar {
  return {
    instrument,
    timeframe: '1h',
    open_time: new Date('2026-08-17T13:00:00.000Z'),
    close_time: new Date('2026-08-17T14:00:00.000Z'),
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 100,
    source,
  };
}

const PRIMARY_MARK: Mark = {
  price: 42,
  observed_at: ASOF,
  source: 'alpaca',
  asset_class: 'stocks',
};

const PRIMARY_QUOTE: Quote = { bid: 1, ask: 2, observed_at: ASOF };

function primarySource(overrides: Partial<DataSource> = {}): DataSource {
  return {
    fetchBars: vi.fn(async () => [barFrom('alpaca')]),
    fetchMark: vi.fn(async () => PRIMARY_MARK),
    fetchQuote: vi.fn(async () => PRIMARY_QUOTE),
    ...overrides,
  };
}

function equitiesFallback(fetchBars = vi.fn(async () => [barFrom('polygon')])) {
  return { leg: 'equities' as const, name: 'polygon', fetchBars };
}

describe('FailoverDataSource', () => {
  it('serves the primary and never touches the fallback while the primary answers', async () => {
    const fallback = equitiesFallback();
    const source = new FailoverDataSource({
      primary: primarySource(),
      primaryName: 'alpaca',
      fallbackFor: () => fallback,
      alert: vi.fn(),
    });

    const bars = await source.fetchBars('SPY', WINDOW, ASOF);

    expect(bars.map((bar) => bar.source)).toEqual(['alpaca']);
    expect(fallback.fetchBars).not.toHaveBeenCalled();
  });

  it('falls back to the secondary vendor when the primary throws', async () => {
    const fallback = equitiesFallback();
    const source = new FailoverDataSource({
      primary: primarySource({
        fetchBars: vi.fn(async () => {
          throw new Error('alpaca 503');
        }),
      }),
      primaryName: 'alpaca',
      fallbackFor: () => fallback,
      alert: vi.fn(),
    });

    const bars = await source.fetchBars('SPY', WINDOW, ASOF);

    // Asserted through `Bar.source`, not through the call count alone: the
    // point of the fallback is that the bars the tick reads carry the vendor
    // that actually served them.
    expect(bars.map((bar) => bar.source)).toEqual(['polygon']);
    expect(fallback.fetchBars).toHaveBeenCalledWith('SPY', WINDOW, ASOF);
  });

  it('alerts with the leg, both vendor names and the primary error before falling back', async () => {
    const events: FailoverEvent[] = [];
    const source = new FailoverDataSource({
      primary: primarySource({
        fetchBars: vi.fn(async () => {
          throw new Error('alpaca 503');
        }),
      }),
      primaryName: 'alpaca',
      fallbackFor: () => equitiesFallback(),
      alert: (event) => events.push(event),
    });

    await source.fetchBars('SPY', WINDOW, ASOF);

    expect(events).toEqual([
      {
        leg: 'equities',
        symbol: 'SPY',
        timeframe: '1h',
        primaryName: 'alpaca',
        fallbackName: 'polygon',
        primaryError: 'alpaca 503',
      },
    ]);
  });

  it('propagates the primary error unchanged for an instrument with no fallback leg', async () => {
    // The crypto leg today: ADR-0015's 2026-08-16 amendment took crypto out of
    // Samurai's scope, so no live crypto fallback is wired and a crypto bar
    // read must behave exactly as it did before this wrapper existed.
    const alert = vi.fn();
    const source = new FailoverDataSource({
      primary: primarySource({
        fetchBars: vi.fn(async () => {
          throw new Error('alpaca 503');
        }),
      }),
      primaryName: 'alpaca',
      fallbackFor: () => undefined,
      alert,
    });

    await expect(source.fetchBars('BTC-USD', WINDOW, ASOF)).rejects.toThrow('alpaca 503');
    expect(alert).not.toHaveBeenCalled();
  });

  it('reports both failures when the fallback fails too', async () => {
    const source = new FailoverDataSource({
      primary: primarySource({
        fetchBars: vi.fn(async () => {
          throw new Error('alpaca 503');
        }),
      }),
      primaryName: 'alpaca',
      fallbackFor: () =>
        equitiesFallback(
          vi.fn(async (): Promise<Bar[]> => {
            throw new Error('polygon 403');
          }),
        ),
      alert: vi.fn(),
    });

    await expect(source.fetchBars('SPY', WINDOW, ASOF)).rejects.toThrow(
      /both alpaca .*and polygon .*failed/s,
    );
  });

  it('serves marks from the primary only, and does NOT fall back on a mark failure', async () => {
    // The load-bearing decision of this class: a mark prices an open position
    // and arms a stop, so a delayed fallback feed must never serve one.
    const fallback = equitiesFallback();
    const source = new FailoverDataSource({
      primary: primarySource({
        fetchMark: vi.fn(async (): Promise<Mark> => {
          throw new Error('alpaca quote 503');
        }),
      }),
      primaryName: 'alpaca',
      fallbackFor: () => fallback,
      alert: vi.fn(),
    });

    await expect(source.fetchMark('SPY', ASOF, 'live')).rejects.toThrow('alpaca quote 503');
    expect(fallback.fetchBars).not.toHaveBeenCalled();
  });

  it('forwards quotes to the primary, and answers null when the primary cannot quote', async () => {
    const quoting = new FailoverDataSource({
      primary: primarySource(),
      primaryName: 'alpaca',
      fallbackFor: () => equitiesFallback(),
      alert: vi.fn(),
    });
    expect(await quoting.fetchQuote('SPY', ASOF)).toEqual(PRIMARY_QUOTE);

    const quoteless = new FailoverDataSource({
      primary: {
        fetchBars: vi.fn(async () => []),
        fetchMark: vi.fn(async () => PRIMARY_MARK),
      },
      primaryName: 'alpaca',
      fallbackFor: () => equitiesFallback(),
      alert: vi.fn(),
    });
    expect(await quoteless.fetchQuote('SPY', ASOF)).toBeNull();
  });
});
