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

/**
 * The circuit breaker on the primary (#824).
 *
 * The failure being defended against is COST, not correctness: a stalled
 * Alpaca read costs ~30s (three 10s attempts plus backoff) and #562 exists for
 * a fourteen-day unattended soak, so paying that per instrument per tick for
 * the length of a stall is the defect. Every case below therefore asserts on
 * the PRIMARY CALL COUNT — "the fallback answered" was already true before
 * this ticket; "the primary was not called at all" is the new claim.
 *
 * Time is a mutable `now` fixture, not `vi.useFakeTimers()` — the breaker
 * reads a clock, it never sets a timer, and the composition root hands it the
 * orchestrator's `Clock`. Nothing here waits on real time.
 */
describe('FailoverDataSource — primary circuit breaker (#824)', () => {
  /** A clock the test steps by hand; mirrors the `SimulatedClock` the live root passes in. */
  function fakeClock(start = ASOF) {
    let at = start.getTime();
    return {
      now: () => new Date(at),
      advance: (ms: number) => {
        at += ms;
      },
    };
  }

  /** A primary whose `fetchBars` fails or succeeds on demand, counting its calls. */
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

    // The threshold's worth of failures — each one DID pay the primary.
    for (let i = 0; i < FAILOVER_CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      await source.fetchBars('SPY', WINDOW, ASOF);
    }
    expect(primary.calls()).toBe(FAILOVER_CIRCUIT_FAILURE_THRESHOLD);

    // The rest of the tick, well inside the cooldown. The fallback count
    // rising while the primary count does not is the whole assertion: a bare
    // "primary not called" would also pass if the reads never happened.
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
    // The per-LEG key, asserted rather than assumed: a per-instrument breaker
    // would still have paid the primary for every other name in the universe.
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
    // The throttle downstream counts failovers to report the true stall rate;
    // a silent skip would make a day-long stall look like it ended.
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

    // The probe: primary touched once more, and it answers.
    const probed = await source.fetchBars('SPY', WINDOW, ASOF);
    expect(probed.map((bar) => bar.source)).toEqual(['alpaca']);
    expect(primary.calls()).toBe(openedAtCalls + 1);

    // Closed — every later read goes to the primary with no further cooldown.
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

    // Four cooldowns of a stall that never lifts: exactly one probe each, so
    // the per-tick primary cost is one read rather than the universe's — and
    // the door is never welded shut.
    let expected = primary.calls();
    for (let cycle = 0; cycle < 4; cycle += 1) {
      clock.advance(FAILOVER_CIRCUIT_COOLDOWN_MS);
      await source.fetchBars('SPY', WINDOW, ASOF);
      expected += 1;
      expect(primary.calls()).toBe(expected);

      // Mid-cooldown reads still skip.
      clock.advance(FAILOVER_CIRCUIT_COOLDOWN_MS / 2);
      await source.fetchBars('SPY', WINDOW, ASOF);
      expect(primary.calls()).toBe(expected);
    }

    // And it still closes whenever the vendor comes back.
    primary.recover();
    clock.advance(FAILOVER_CIRCUIT_COOLDOWN_MS);
    const bars = await source.fetchBars('SPY', WINDOW, ASOF);
    expect(bars.map((bar) => bar.source)).toEqual(['alpaca']);
  });

  it('cannot stick open on a probe that never settles', async () => {
    // The one hole a `probing` flag has: a hung promise. After a further
    // cooldown the probe is presumed lost and a new one is admitted, so a
    // single wedged request cannot hold the circuit open for a 14-day soak.
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

    // The probe hangs. `fetchBars` never resolves, so it is deliberately not
    // awaited — the read is left dangling exactly as it would be in life.
    hang = true;
    clock.advance(FAILOVER_CIRCUIT_COOLDOWN_MS);
    void source.fetchBars('SPY', WINDOW, ASOF);
    await Promise.resolve();
    expect(fetchBars.mock.calls.length).toBe(before + 1);

    // While that one is plausibly still in flight, nobody else probes.
    clock.advance(FAILOVER_CIRCUIT_COOLDOWN_MS / 2);
    await source.fetchBars('SPY', WINDOW, ASOF);
    expect(fetchBars.mock.calls.length).toBe(before + 1);

    // A whole further cooldown later it is presumed lost and a new probe runs
    // — also left dangling, since the stalled primary hangs this one too.
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

    // An NTP correction (or a rewound simulated clock) an hour backwards must
    // not pin the breaker open for that hour.
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

    // Threshold-minus-one failures, then a success, then threshold-minus-one
    // again: without the reset the circuit would already be open here.
    for (let i = 0; i < FAILOVER_CIRCUIT_FAILURE_THRESHOLD - 1; i += 1) {
      await source.fetchBars('SPY', WINDOW, ASOF);
    }
    primary.recover();
    await source.fetchBars('SPY', WINDOW, ASOF);
    primary.stall();
    for (let i = 0; i < FAILOVER_CIRCUIT_FAILURE_THRESHOLD - 1; i += 1) {
      await source.fetchBars('SPY', WINDOW, ASOF);
    }

    // Every one of those reads reached the primary — the count never reached
    // the threshold, because the success in the middle cleared it.
    const reads = 2 * (FAILOVER_CIRCUIT_FAILURE_THRESHOLD - 1) + 1;
    expect(primary.calls()).toBe(reads);
  });

  it('never breaks the circuit for an instrument that has no fallback', async () => {
    // Skipping the primary for an instrument with nowhere to route would turn
    // a slow read into a guaranteed failure.
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
