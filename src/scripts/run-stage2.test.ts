import { describe, expect, it } from 'vitest';
import type { PolygonAggregate, PolygonClient } from '../cost-model-backtest/index.js';
import { CRYPTO_SYMBOLS, defaultFiveYearWindow, runStage2, STOCK_SYMBOLS } from './run-stage2.js';

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

describe('runStage2', () => {
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

    // MinBTL is always computable (window/N only) — 12 distinct configs.
    expect(verdict.n_distinct_trials).toBe(12);
    expect(verdict.min_btl).toBeDefined();

    // Kill-line checks: 12 configs x 2 asset classes = 24 entries.
    expect(verdict.kill_line_checks).toHaveLength(24);
    expect(verdict.kill_line_checks.filter((c) => c.asset_class === 'stocks')).toHaveLength(12);
    expect(verdict.kill_line_checks.filter((c) => c.asset_class === 'crypto')).toHaveLength(12);

    // PBO is attempted per asset class present (2 outcomes for stocks+crypto).
    expect(verdict.pbo).toHaveLength(2);

    // DSR is always a typed refusal today (see stage2-verdict.ts module doc).
    expect(verdict.dsr_note.error).toBe(
      'dsr_requires_per_period_sharpe_not_exposed_by_metrics_suite',
    );

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

  it('ingests every symbol even when the fake client returns no data, then fails fast rather than rendering a hollow verdict', async () => {
    const window = defaultFiveYearWindow(new Date(Date.UTC(2024, 0, 1)));
    const calls: string[] = [];

    // No bars ingested means the replay driver produces zero trades, which
    // `runTrialGrid` deliberately aborts on rather than returning a
    // partial/misleading result set (trial-execution.ts's fail-fast
    // rationale) — this asserts every symbol was still *attempted* before
    // that failure, i.e. ingestion itself does not silently skip anything.
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
    ).rejects.toThrow(/runTrialGrid: failed on config_hash=/);

    expect(calls.sort()).toEqual([...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS].sort());
  });
});
