import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PolygonAggregate, PolygonClient } from '../cost-model-backtest/index.js';
import { minbtl } from '../cost-model-backtest/index.js';
import {
  CRYPTO_SYMBOLS,
  defaultFiveYearWindow,
  effectiveWindow,
  runStage2,
  STAGE2_SCRATCH_DB_PATH,
  STOCK_SYMBOLS,
} from './run-stage2.js';

const DAY_MS = 86_400_000;

/**
 * A long, gently-trending sine series — mirrors
 * `trial-execution.test.ts`'s `buildTrendingBars` fixture, which was
 * verified by simulation to produce at least one signal-exit trade per grid
 * config in every walk-forward fold's test slice.
 */
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

/** A fake `PolygonClient` — verifies `runStage2`'s wiring without any network call. */
function fakePolygonClient(startMs: number): PolygonClient {
  return {
    async fetchAggregates() {
      return trendingAggregates(startMs);
    },
  };
}

/**
 * Like `fakePolygonClient`, but crypto bars close half a day off the stock
 * close — as they really do, since crypto has no session and stock daily bars
 * close at the US equity bell.
 *
 * **This asymmetry is what the original fixture lacked, and why #420 survived
 * every test.** With all six symbols on identical timestamps, the whole-store
 * union is indistinguishable from either asset class's own timeline, so a
 * replay driven off the wrong one produces exactly the right answer.
 */
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

    // Each class has 500 bars whose close times never coincide with the other's,
    // so the union is ~1000 and either class alone is ~500. Ranges rather than
    // exact counts because a bar's close is its open + 1 day, so the window's
    // last open falls outside it.
    expect(stocks).toBeGreaterThan(450);
    expect(stocks).toBeLessThan(550);
    expect(crypto).toBeGreaterThan(450);
    expect(crypto).toBeLessThan(550);

    // The regression guard proper: before the fix both read the whole-store
    // union (~1000) — an identical, doubled count for two asset classes whose
    // bars do not coincide.
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

    // #405: the grid is sized to what the sample supports BEFORE it runs, so
    // the trial count is MinBTL's cap rather than the full cross-product —
    // and `exceeded` is false by construction rather than reported after the
    // fact. Asserted against `minbtl` so this states the rule instead of
    // pinning this fixture's particular span.
    const { limit } = minbtl(window);
    expect(verdict.n_distinct_trials).toBe(limit);
    expect(verdict.min_btl.exceeded).toBe(false);

    // Kill-line checks: one per (retained config, asset class).
    expect(verdict.kill_line_checks).toHaveLength(limit * 2);
    expect(verdict.kill_line_checks.filter((c) => c.asset_class === 'stocks')).toHaveLength(limit);
    expect(verdict.kill_line_checks.filter((c) => c.asset_class === 'crypto')).toHaveLength(limit);

    // PBO is attempted per asset class present (2 outcomes for stocks+crypto).
    expect(verdict.pbo).toHaveLength(2);

    // DSR is attempted per asset class present, and — since #406 — actually
    // computed. This is the assertion that catches the seam existing but
    // nothing calling it: `runStage2` must opt into the CSCV pass and hand the
    // per-period Sharpe through, or these fall back to typed refusals.
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

    // The full report was printed: per-config metrics, kill-line, MinBTL, PBO,
    // DSR, and the final pass/kill line.
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

    // Before the effective-window check this surfaced as
    // `runTrialGrid: failed on config_hash=...` wrapping
    // `toReturnSeries: no bars in the sample` — the real failure four layers
    // down from its cause, which is exactly how the first live run presented.
    // Now it names the symbol and says why a partial grid is not the grid the
    // gate is defined on. Every symbol is still *attempted* first: ingestion
    // does not silently skip anything.
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

/**
 * The first live run (2026-08-05) asked for 5 years and the Polygon plan
 * served 2 — see docs/research/archive/2026-08-05-stage2-verdict-first-real-run.md.
 * MinBTL's trial cap is a function of sample LENGTH, so a verdict rendered
 * over a window the data does not cover overstates how many configs the
 * sample supports: the exact overfitting that number exists to catch.
 */
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
    // One symbol starts later still — the intersection has to follow the
    // LATEST first bar, or its folds replay over a period it has no data for.
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

    // Narrowing past a missing symbol would change what the verdict is a
    // verdict ABOUT, so this is a hard failure rather than a smaller universe.
    expect(() => effectiveWindow(storeWith(coverage), REQUESTED)).toThrow(
      /runStage2: ETH-USD has no bars in/,
    );
  });

  it('refuses a universe whose per-symbol coverage does not overlap at all', () => {
    // Disjoint coverage: every symbol has bars, so the per-symbol guard above
    // passes, but one ends before another begins. Left unguarded this returns
    // start > end and replay/folds/MinBTL run on an inverted window — the same
    // opaque downstream failure the intersection exists to prevent.
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
    // `Stage2HistoricalStore` orders by close_time ASC, but the structural
    // parameter type cannot say so. Taking bars[0]/bars.at(-1) would narrow to
    // the wrong range here instead of failing.
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
  /**
   * The composition root IS the bug this ticket reports, so it is what gets
   * asserted. `runStage2`'s `dbPath` plumbing was already correct and already
   * covered; what was wrong is that the one caller which actually spends money
   * on vendor calls passed nothing and silently got `:memory:` — so every run
   * began with an empty database and re-pulled the whole five-year window.
   *
   * Read from source because the entrypoint sits behind an `import.meta.url`
   * guard that cannot be imported without launching a real Polygon run. Same
   * technique as `replay-driver.test.ts`'s import guard.
   */
  const source = readFileSync(fileURLToPath(new URL('./run-stage2.ts', import.meta.url)), 'utf8');
  const entrypoint = source.slice(source.indexOf('if (import.meta.url ==='));

  it('hands the direct-run entrypoint a persistent scratch path', () => {
    expect(entrypoint).not.toBe('');
    expect(entrypoint).toContain('dbPath: STAGE2_SCRATCH_DB_PATH');
  });

  it('keeps that path a research scratch file, separate from the shared store', () => {
    expect(STAGE2_SCRATCH_DB_PATH).not.toBe(':memory:');
    // `data/` so the existing `*.sqlite` gitignore rule covers it; not
    // `samurai-*`, which is the shared store's live run state.
    expect(STAGE2_SCRATCH_DB_PATH).toMatch(/^data\/[\w-]+\.sqlite$/);
    expect(STAGE2_SCRATCH_DB_PATH).not.toContain('samurai-');
  });

  it("leaves runStage2's own default at :memory: so tests stay isolated", () => {
    expect(source).toContain("deps.dbPath ?? ':memory:'");
  });
});
