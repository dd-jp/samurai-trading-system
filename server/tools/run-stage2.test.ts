import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UsEquityRegularHoursCalendar } from './../providers/market-data-service/index.js';
import type { PolygonAggregate, PolygonClient } from './backtest/index.js';
import { minbtl } from './backtest/index.js';
import {
  CRYPTO_SYMBOLS,
  defaultFiveYearWindow,
  effectiveWindow,
  runStage2,
  STAGE2_SCRATCH_DB_PATH,
  STOCK_SYMBOLS,
  universeFor,
} from './run-stage2.js';

const DAY_MS = 86_400_000;

function trendingAggregates(startMs: number): PolygonAggregate[] {
  const closes = Array.from(
    { length: 500 },
    (_, i) => 100 + 30 * Math.sin((2 * Math.PI * i) / 100) + 0.02 * i,
  );
  return closes.map((close, i) => {
    const prevClose = i === 0 ? close : (closes[i - 1] as number);
    return {
      t: startMs + i * DAY_MS,
      o: prevClose,
      h: Math.max(close, prevClose) + 1,
      l: Math.min(close, prevClose) - 1,
      c: close,
      v: 1_000,
    };
  });
}

function fakePolygonClient(startMs: number): PolygonClient {
  return {
    async fetchAggregates() {
      return trendingAggregates(startMs);
    },
  };
}

function fakeTwoCadencePolygonClient(startMs: number): PolygonClient {
  return {
    async fetchAggregates(symbol) {
      const isCrypto = (CRYPTO_SYMBOLS as readonly string[]).includes(symbol);
      const offset = isCrypto ? DAY_MS / 2 : 0;
      return trendingAggregates(startMs + offset);
    },
  };
}

describe('runStage2', () => {
  it('scores each asset class over its own bars, not the union of both (#420)', async () => {
    const start = Date.UTC(2020, 0, 1);
    const window = { start: new Date(start), end: new Date(start + 500 * DAY_MS) };

    const verdict = await runStage2({
      polygonClient: fakeTwoCadencePolygonClient(start),
      window,
      print: () => {},
    });

    const observationsFor = (asset_class: 'crypto' | 'stocks'): number[] => {
      const outcome = verdict.dsr.find((entry) => entry.asset_class === asset_class);
      if (outcome === undefined || !('result' in outcome)) {
        throw new Error(`expected a computed DSR for ${asset_class}`);
      }
      return [outcome.result.observations];
    };

    const [stocks] = observationsFor('stocks');
    const [crypto] = observationsFor('crypto');

    expect(stocks).toBeGreaterThan(450);
    expect(stocks).toBeLessThan(550);
    expect(crypto).toBeGreaterThan(450);
    expect(crypto).toBeLessThan(550);

    expect(stocks + crypto).toBeGreaterThan(900);
  });

  it('ingests all 6 MVP-universe symbols, runs the 12-config grid, and renders a verdict', async () => {
    const start = Date.UTC(2020, 0, 1);
    const client = fakePolygonClient(start);
    const window = { start: new Date(start), end: new Date(start + 499 * DAY_MS) };
    const lines: string[] = [];

    const verdict = await runStage2({
      polygonClient: client,
      window,
      print: (line) => lines.push(line),
    });

    const { limit } = minbtl(window);
    expect(verdict.n_distinct_trials).toBe(limit);
    expect(verdict.min_btl.exceeded).toBe(false);

    expect(verdict.kill_line_checks).toHaveLength(limit * 2);
    expect(verdict.kill_line_checks.filter((c) => c.asset_class === 'stocks')).toHaveLength(limit);
    expect(verdict.kill_line_checks.filter((c) => c.asset_class === 'crypto')).toHaveLength(limit);

    expect(verdict.pbo).toHaveLength(2);

    expect(verdict.dsr).toHaveLength(2);
    for (const outcome of verdict.dsr) {
      expect(
        'result' in outcome ? 'computed' : `refused: ${outcome.error} — ${outcome.detail}`,
      ).toBe('computed');
    }
    for (const outcome of verdict.pbo) {
      expect(
        'result' in outcome ? 'computed' : `refused: ${outcome.error} — ${outcome.detail}`,
      ).toBe('computed');
    }

    const report = lines.join('\n');
    expect(report).toContain('=== Stage 2: per-config metrics ===');
    expect(report).toContain('=== Stage 2: kill-line checks (OOS Sharpe) ===');
    expect(report).toContain('=== Stage 2: MinBTL ===');
    expect(report).toContain('=== Stage 2: PBO ===');
    expect(report).toContain('=== Stage 2: DSR ===');
    expect(report).toMatch(/=== Stage 2 VERDICT: (PASS|KILL\/INCOMPLETE) ===/);

    for (const symbol of [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS]) {
      expect(report).toContain(`ingested ${symbol}:`);
    }
  });

  it('ingests every symbol even when the fake client returns no data, then names the empty symbol rather than rendering a hollow verdict', async () => {
    const window = defaultFiveYearWindow(new Date(Date.UTC(2024, 0, 1)));
    const calls: string[] = [];

    await expect(
      runStage2({
        polygonClient: {
          async fetchAggregates(symbol) {
            calls.push(symbol);
            return [];
          },
        },
        window,
        print: () => {},
      }),
    ).rejects.toThrow(/runStage2: SPY has no bars in/);

    expect(calls.sort()).toEqual([...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS].sort());
  });
});

describe('effectiveWindow', () => {
  const REQUESTED = {
    start: new Date(Date.UTC(2021, 0, 1)),
    end: new Date(Date.UTC(2026, 0, 1)),
  };

  function storeWith(coverage: Record<string, { first: Date; last: Date }>) {
    return {
      bars(symbol: string) {
        const span = coverage[symbol];
        if (span === undefined) return [];
        return [{ close_time: span.first }, { close_time: span.last }];
      },
    };
  }

  it('narrows to the range every symbol actually covers', () => {
    const coverage = Object.fromEntries(
      [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS].map((symbol) => [
        symbol,
        { first: new Date(Date.UTC(2024, 7, 6)), last: new Date(Date.UTC(2026, 0, 1)) },
      ]),
    );
    coverage.TSLA = { first: new Date(Date.UTC(2025, 0, 1)), last: new Date(Date.UTC(2026, 0, 1)) };

    const effective = effectiveWindow(storeWith(coverage), REQUESTED);

    expect(effective.start.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(effective.end.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('leaves the requested window alone when the data covers it', () => {
    const coverage = Object.fromEntries(
      [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS].map((symbol) => [
        symbol,
        { first: REQUESTED.start, last: REQUESTED.end },
      ]),
    );

    expect(effectiveWindow(storeWith(coverage), REQUESTED)).toEqual(REQUESTED);
  });

  it('refuses a universe with a symbol that has no bars at all', () => {
    const coverage = Object.fromEntries(
      [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS]
        .filter((symbol) => symbol !== 'ETH-USD')
        .map((symbol) => [symbol, { first: REQUESTED.start, last: REQUESTED.end }]),
    );

    expect(() => effectiveWindow(storeWith(coverage), REQUESTED)).toThrow(
      /runStage2: ETH-USD has no bars in/,
    );
  });

  it('refuses a universe whose per-symbol coverage does not overlap at all', () => {
    const coverage = Object.fromEntries(
      [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS].map((symbol) => [
        symbol,
        { first: new Date(Date.UTC(2021, 0, 1)), last: new Date(Date.UTC(2023, 0, 1)) },
      ]),
    );
    coverage['BTC-USD'] = {
      first: new Date(Date.UTC(2024, 0, 1)),
      last: new Date(Date.UTC(2026, 0, 1)),
    };

    expect(() => effectiveWindow(storeWith(coverage), REQUESTED)).toThrow(
      /no window every symbol covers/,
    );
  });

  it('finds the bar bounds regardless of the order the store returns them in', () => {
    const descending = {
      bars(symbol: string) {
        const span =
          symbol === 'TSLA'
            ? { first: new Date(Date.UTC(2025, 0, 1)), last: new Date(Date.UTC(2026, 0, 1)) }
            : { first: new Date(Date.UTC(2024, 7, 6)), last: new Date(Date.UTC(2026, 0, 1)) };
        return [{ close_time: span.last }, { close_time: span.first }];
      },
    };

    const effective = effectiveWindow(descending, REQUESTED);

    expect(effective.start.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(effective.end.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('a direct run persists its bars instead of starting empty (#495)', () => {
  const source = readFileSync(fileURLToPath(new URL('./run-stage2.ts', import.meta.url)), 'utf8');
  const entrypoint = source.slice(source.indexOf('if (import.meta.url ==='));

  it('hands the direct-run entrypoint a persistent scratch path', () => {
    expect(entrypoint).not.toBe('');
    expect(entrypoint).toContain('dbPath: STAGE2_SCRATCH_DB_PATH');
  });

  it('keeps that path a research scratch file, separate from the shared store', () => {
    expect(STAGE2_SCRATCH_DB_PATH).not.toBe(':memory:');
    expect(STAGE2_SCRATCH_DB_PATH).toMatch(/^data\/[\w-]+\.sqlite$/);
    expect(STAGE2_SCRATCH_DB_PATH).not.toContain('samurai-');
  });

  it("leaves runStage2's own default at :memory: so tests stay isolated", () => {
    expect(source).toContain("deps.dbPath ?? ':memory:'");
  });
});

describe('runStage2 at minute resolution (#664)', () => {
  const CALENDAR = new UsEquityRegularHoursCalendar();
  const MINUTE_MS = 60_000;
  const BARS_PER_SESSION = 90;

  function sessionCloses(from: Date, count: number, everyNthSession: number): Date[] {
    const closes: Date[] = [];
    let cursor = from;
    let seen = 0;
    while (closes.length < count) {
      const next = CALENDAR.sessionEnd(cursor);
      if (next === null) throw new Error('the equity calendar must report a close');
      if (seen % everyNthSession === 0) closes.push(next);
      seen++;
      cursor = next;
    }
    return closes;
  }

  function minuteAggregates(closes: readonly Date[]): PolygonAggregate[] {
    const out: PolygonAggregate[] = [];
    closes.forEach((close, session) => {
      const drift = session % 2 === 0 ? 0.02 : -0.02;
      const base = 100 + 10 * Math.sin((2 * Math.PI * session) / 9);
      for (let i = 0; i < BARS_PER_SESSION; i++) {
        const openMs = close.getTime() - (BARS_PER_SESSION - i) * MINUTE_MS;
        const price = base + drift * i;
        out.push({
          t: openMs,
          o: price,
          h: price + 0.05,
          l: price - 0.05,
          c: price + drift,
          v: 5_000,
        });
      }
    });
    return out;
  }

  it('ingests equities only, replays minute bars, and renders a verdict', async () => {
    const closes = sessionCloses(new Date('2026-01-05T12:00:00.000Z'), 40, 8);
    const first = closes[0] as Date;
    const last = closes[closes.length - 1] as Date;
    const window = {
      start: new Date(first.getTime() - BARS_PER_SESSION * MINUTE_MS),
      end: new Date(last.getTime() + MINUTE_MS),
    };

    const asked: { symbol: string; timeframe: string }[] = [];
    const client: PolygonClient = {
      async fetchAggregates(symbol, _window, timeframe) {
        asked.push({ symbol, timeframe });
        return minuteAggregates(closes);
      },
    };

    const lines: string[] = [];
    const verdict = await runStage2({
      polygonClient: client,
      window,
      timeframe: '1m',
      print: (line) => lines.push(line),
    });

    expect(asked.every((call) => call.timeframe === '1m')).toBe(true);
    expect(asked.map((call) => call.symbol).sort()).toEqual([...STOCK_SYMBOLS].sort());
    for (const symbol of CRYPTO_SYMBOLS) {
      expect(asked.some((call) => call.symbol === symbol)).toBe(false);
    }

    expect(verdict.kill_line_checks.length).toBeGreaterThan(0);
    expect(verdict.kill_line_checks.every((check) => check.asset_class === 'stocks')).toBe(true);

    const printed = lines.join('\n');
    expect(printed).toContain('INTRADAY run');
    expect(printed).toContain('STRUCTURAL FLOOR');
    expect(printed).toContain('UNDER-charges');
    expect(printed).toContain('US-EQUITY PROXY');
    expect(printed).not.toContain('order of magnitude');
  }, 120_000);
});

describe('universeFor (#664)', () => {
  it('keeps the full six-symbol MVP universe for a daily run', () => {
    expect(universeFor('1d')).toEqual([...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS]);
  });

  it('narrows an intraday run to equities — crypto left scope (ADR-0015)', () => {
    expect(universeFor('1m')).toEqual([...STOCK_SYMBOLS]);
    expect(universeFor('5m')).toEqual([...STOCK_SYMBOLS]);
  });
});
