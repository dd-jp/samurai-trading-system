import { describe, expect, it, vi } from 'vitest';

import type { Bar, DataSource, Mark, Quote } from '../types.js';
import {
  FAILOVER_CIRCUIT_COOLDOWN_MS,
  FAILOVER_CIRCUIT_FAILURE_THRESHOLD,
  FailoverDataSource,
} from './failover-data-source.js';
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

describe('FailoverDataSource — primary circuit breaker (#824)', () => {
  function fakeClock(start = ASOF) {
    let at = start.getTime();
    return {
      now: () => new Date(at),
      advance: (ms: number) => {
        at += ms;
      },
    };
  }

  function switchablePrimary() {
    let failing = true;
    const fetchBars = vi.fn(async (): Promise<Bar[]> => {
      if (failing) throw new Error('alpaca 503');
      return [barFrom('alpaca')];
    });
    return {
      calls: () => fetchBars.mock.calls.length,
      recover: () => {
        failing = false;
      },
      stall: () => {
        failing = true;
      },
      source: primarySource({ fetchBars }),
    };
  }

  it('opens after N consecutive failures and then SKIPS the primary entirely', async () => {
    const clock = fakeClock();
    const primary = switchablePrimary();
    const fallback = equitiesFallback();
    const source = new FailoverDataSource({
      primary: primary.source,
      primaryName: 'alpaca',
      fallbackFor: () => fallback,
      alert: vi.fn(),
      now: clock.now,
    });

    for (let i = 0; i < FAILOVER_CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      await source.fetchBars('SPY', WINDOW, ASOF);
    }
    expect(primary.calls()).toBe(FAILOVER_CIRCUIT_FAILURE_THRESHOLD);

    const fallbackCallsBefore = fallback.fetchBars.mock.calls.length;
    for (let i = 0; i < 5; i += 1) {
      clock.advance(1_000);
      const bars = await source.fetchBars('SPY', WINDOW, ASOF);
      expect(bars.map((bar) => bar.source)).toEqual(['polygon']);
    }
    expect(primary.calls()).toBe(FAILOVER_CIRCUIT_FAILURE_THRESHOLD);
    expect(fallback.fetchBars.mock.calls.length).toBe(fallbackCallsBefore + 5);
  });

  it('opens on the leg, so a stall proven on one instrument spares the next one its timeout', async () => {
    const clock = fakeClock();
    const primary = switchablePrimary();
    const source = new FailoverDataSource({
      primary: primary.source,
      primaryName: 'alpaca',
      fallbackFor: () => equitiesFallback(),
      alert: vi.fn(),
      now: clock.now,
    });

    for (const symbol of ['SPY', 'QQQ', 'AAPL']) {
      await source.fetchBars(symbol, WINDOW, ASOF);
    }
    expect(primary.calls()).toBe(3);

    await source.fetchBars('TSLA', WINDOW, ASOF);
    expect(primary.calls()).toBe(3);
  });

  it('still alerts on an open-circuit read, naming the skip rather than going quiet', async () => {
    const clock = fakeClock();
    const primary = switchablePrimary();
    const events: FailoverEvent[] = [];
    const source = new FailoverDataSource({
      primary: primary.source,
      primaryName: 'alpaca',
      fallbackFor: () => equitiesFallback(),
      alert: (event) => events.push(event),
      now: clock.now,
    });

    for (let i = 0; i < FAILOVER_CIRCUIT_FAILURE_THRESHOLD + 1; i += 1) {
      await source.fetchBars('SPY', WINDOW, ASOF);
    }

    expect(events).toHaveLength(FAILOVER_CIRCUIT_FAILURE_THRESHOLD + 1);
    const last = events.at(-1) as FailoverEvent;
    expect(last.primaryError).toMatch(/circuit is OPEN/);
    expect(last.fallbackName).toBe('polygon');
  });

  it('recovers on its own: the first read after the cooldown probes, and a healthy primary closes it', async () => {
    const clock = fakeClock();
    const primary = switchablePrimary();
    const source = new FailoverDataSource({
      primary: primary.source,
      primaryName: 'alpaca',
      fallbackFor: () => equitiesFallback(),
      alert: vi.fn(),
      now: clock.now,
    });

    for (let i = 0; i < FAILOVER_CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      await source.fetchBars('SPY', WINDOW, ASOF);
    }
    const openedAtCalls = primary.calls();

    primary.recover();
    clock.advance(FAILOVER_CIRCUIT_COOLDOWN_MS);

    const probed = await source.fetchBars('SPY', WINDOW, ASOF);
    expect(probed.map((bar) => bar.source)).toEqual(['alpaca']);
    expect(primary.calls()).toBe(openedAtCalls + 1);

    await source.fetchBars('SPY', WINDOW, ASOF);
    expect(primary.calls()).toBe(openedAtCalls + 2);
  });

  it('cannot stick open: a failed probe re-arms the cooldown and the NEXT one still happens', async () => {
    const clock = fakeClock();
    const primary = switchablePrimary();
    const source = new FailoverDataSource({
      primary: primary.source,
      primaryName: 'alpaca',
      fallbackFor: () => equitiesFallback(),
      alert: vi.fn(),
      now: clock.now,
    });

    for (let i = 0; i < FAILOVER_CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      await source.fetchBars('SPY', WINDOW, ASOF);
    }

    let expected = primary.calls();
    for (let cycle = 0; cycle < 4; cycle += 1) {
      clock.advance(FAILOVER_CIRCUIT_COOLDOWN_MS);
      await source.fetchBars('SPY', WINDOW, ASOF);
      expected += 1;
      expect(primary.calls()).toBe(expected);

      clock.advance(FAILOVER_CIRCUIT_COOLDOWN_MS / 2);
      await source.fetchBars('SPY', WINDOW, ASOF);
      expect(primary.calls()).toBe(expected);
    }

    primary.recover();
    clock.advance(FAILOVER_CIRCUIT_COOLDOWN_MS);
    const bars = await source.fetchBars('SPY', WINDOW, ASOF);
    expect(bars.map((bar) => bar.source)).toEqual(['alpaca']);
  });

  it('cannot stick open on a probe that never settles', async () => {
    const clock = fakeClock();
    let hang = false;
    const fetchBars = vi.fn(async (): Promise<Bar[]> => {
      if (hang) return new Promise<Bar[]>(() => {});
      throw new Error('alpaca 503');
    });
    const source = new FailoverDataSource({
      primary: primarySource({ fetchBars }),
      primaryName: 'alpaca',
      fallbackFor: () => equitiesFallback(),
      alert: vi.fn(),
      now: clock.now,
    });

    for (let i = 0; i < FAILOVER_CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      await source.fetchBars('SPY', WINDOW, ASOF);
    }
    const before = fetchBars.mock.calls.length;

    hang = true;
    clock.advance(FAILOVER_CIRCUIT_COOLDOWN_MS);
    void source.fetchBars('SPY', WINDOW, ASOF);
    await Promise.resolve();
    expect(fetchBars.mock.calls.length).toBe(before + 1);

    clock.advance(FAILOVER_CIRCUIT_COOLDOWN_MS / 2);
    await source.fetchBars('SPY', WINDOW, ASOF);
    expect(fetchBars.mock.calls.length).toBe(before + 1);

    clock.advance(FAILOVER_CIRCUIT_COOLDOWN_MS);
    void source.fetchBars('SPY', WINDOW, ASOF);
    await Promise.resolve();
    expect(fetchBars.mock.calls.length).toBe(before + 2);
  });

  it('treats a clock that steps BACKWARDS as elapsed rather than as an endless cooldown', async () => {
    const clock = fakeClock();
    const primary = switchablePrimary();
    const source = new FailoverDataSource({
      primary: primary.source,
      primaryName: 'alpaca',
      fallbackFor: () => equitiesFallback(),
      alert: vi.fn(),
      now: clock.now,
    });

    for (let i = 0; i < FAILOVER_CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      await source.fetchBars('SPY', WINDOW, ASOF);
    }
    const before = primary.calls();

    clock.advance(-60 * 60 * 1000);
    await source.fetchBars('SPY', WINDOW, ASOF);
    expect(primary.calls()).toBe(before + 1);
  });

  it('resets the consecutive-failure count on a successful primary read', async () => {
    const clock = fakeClock();
    const primary = switchablePrimary();
    const source = new FailoverDataSource({
      primary: primary.source,
      primaryName: 'alpaca',
      fallbackFor: () => equitiesFallback(),
      alert: vi.fn(),
      now: clock.now,
    });

    for (let i = 0; i < FAILOVER_CIRCUIT_FAILURE_THRESHOLD - 1; i += 1) {
      await source.fetchBars('SPY', WINDOW, ASOF);
    }
    primary.recover();
    await source.fetchBars('SPY', WINDOW, ASOF);
    primary.stall();
    for (let i = 0; i < FAILOVER_CIRCUIT_FAILURE_THRESHOLD - 1; i += 1) {
      await source.fetchBars('SPY', WINDOW, ASOF);
    }

    const reads = 2 * (FAILOVER_CIRCUIT_FAILURE_THRESHOLD - 1) + 1;
    expect(primary.calls()).toBe(reads);
  });

  it('never breaks the circuit for an instrument that has no fallback', async () => {
    const clock = fakeClock();
    const primary = switchablePrimary();
    const source = new FailoverDataSource({
      primary: primary.source,
      primaryName: 'alpaca',
      fallbackFor: () => undefined,
      alert: vi.fn(),
      now: clock.now,
    });

    for (let i = 0; i < FAILOVER_CIRCUIT_FAILURE_THRESHOLD + 2; i += 1) {
      await expect(source.fetchBars('BTC-USD', WINDOW, ASOF)).rejects.toThrow('alpaca 503');
    }
    expect(primary.calls()).toBe(FAILOVER_CIRCUIT_FAILURE_THRESHOLD + 2);
  });
});
