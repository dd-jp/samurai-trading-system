/**
 * The live OHLCV failover's WIRING decisions (#562), as distinct from the
 * failover mechanism itself (`failover-data-source.test.ts`) and from the
 * fact that the composition root builds one (`production.test.ts`).
 *
 * Two of them are decisions the issue asked to be recorded with reasoning,
 * and a documented decision nothing asserts is a comment: the
 * malformed-pacing-override posture, and that a failed alert POST cannot
 * turn a survived vendor stall into a thrown tick.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Bar, BarWindow } from '../../../providers/market-data-service/index.js';
import { DEFAULT_POLYGON_PACING, type LogEntry, type Logger } from '../../../shared/index.js';
import { buildFailoverDataSource, resolveFallbackPacing } from './data-failover.js';

const ASOF = new Date('2026-08-17T14:00:00.000Z');
const WINDOW: BarWindow = { timeframe: '1h', lookback: 2 };

function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

function fallbackBar(): Bar {
  return {
    instrument: 'SPY',
    timeframe: '1h',
    open_time: new Date('2026-08-17T13:00:00.000Z'),
    close_time: ASOF,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 10,
    source: 'polygon',
  };
}

function stallingPrimary() {
  return {
    fetchBars: vi.fn(async (): Promise<Bar[]> => {
      throw new Error('alpaca 503');
    }),
    fetchMark: vi.fn(async () => {
      throw new Error('unreachable — no case here marks');
    }),
  };
}

describe('resolveFallbackPacing — the boot-path pacing decision', () => {
  it('applies a well-formed SAMURAI_PACING_POLYGON_* override', () => {
    const logger = recordingLogger();

    const pacing = resolveFallbackPacing(logger, { SAMURAI_PACING_POLYGON_CAPACITY: '3' });

    expect(pacing.capacity).toBe(3);
    expect(logger.entries).toHaveLength(0);
  });

  it('WARNS AND DEFAULTS on a malformed override rather than refusing to boot', () => {
    // The decision #562 asked to be recorded, asserted rather than only
    // documented: this variable paces a DEGRADATION MITIGATION, touched only
    // once the primary vendor has already failed. Refusing to boot over it
    // would take the whole book offline for a typo — strictly worse than the
    // stall the fallback exists to survive. Contrast `SAMURAI_ALERTS` /
    // `SAMURAI_MODE`, which gate whether the system operates correctly and
    // are refusals on purpose.
    const logger = recordingLogger();

    const pacing = resolveFallbackPacing(logger, {
      SAMURAI_PACING_POLYGON_REFILL_PER_SEC: 'not-a-number',
    });

    expect(pacing).toEqual(DEFAULT_POLYGON_PACING);
    const warned = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.message).toContain('SAMURAI_PACING_POLYGON');
  });
});

describe('buildFailoverDataSource', () => {
  it('fails an equities instrument over and reports it on the alert channel', async () => {
    const logger = recordingLogger();
    const postDataFailoverAlert = vi.fn(async () => undefined);
    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      equitiesFallbackBarFetcher: async () => [fallbackBar()],
      alertChannel: { postDataFailoverAlert },
      logger,
      now: () => ASOF,
    });

    const bars = await source.fetchBars('SPY', WINDOW, ASOF);

    expect(bars.map((bar) => bar.source)).toEqual(['polygon']);
    expect(postDataFailoverAlert).toHaveBeenCalledWith(
      expect.objectContaining({ leg: 'equities', symbol: 'SPY', reported_at: ASOF }),
    );
  });

  it('leaves a crypto instrument with no fallback — equities-only by scope', async () => {
    // ADR-0015's 2026-08-16 amendment took crypto out of Samurai's scope, so
    // the Coinbase/Bitstamp pairing the backfill script uses has no live
    // counterpart. A crypto bar read must behave exactly as it did before.
    const equitiesFallbackBarFetcher = vi.fn(async () => [fallbackBar()]);
    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      universe: [{ asset: 'BTC-USD', asset_class: 'crypto' }],
      equitiesFallbackBarFetcher,
      alertChannel: { postDataFailoverAlert: vi.fn(async () => undefined) },
      logger: recordingLogger(),
      now: () => ASOF,
    });

    await expect(source.fetchBars('BTC-USD', WINDOW, ASOF)).rejects.toThrow('alpaca 503');
    expect(equitiesFallbackBarFetcher).not.toHaveBeenCalled();
  });

  it('logs, and does not rethrow, an alert POST that fails', async () => {
    // A Telegram outage must not turn "the fallback served these bars" into
    // "the tick threw" — the same posture `checkMiCoverage` documents.
    const logger = recordingLogger();
    const source = buildFailoverDataSource({
      primary: stallingPrimary(),
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      equitiesFallbackBarFetcher: async () => [fallbackBar()],
      alertChannel: {
        postDataFailoverAlert: async () => {
          throw new Error('telegram 502');
        },
      },
      logger,
      now: () => ASOF,
    });

    const bars = await source.fetchBars('SPY', WINDOW, ASOF);
    // The rejection is handled off the fetch's own promise chain, so let the
    // microtask queue drain before reading the log.
    await Promise.resolve();

    expect(bars).toHaveLength(1);
    const errors = logger.entries.filter((entry) => entry.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('telegram 502');
  });
});
