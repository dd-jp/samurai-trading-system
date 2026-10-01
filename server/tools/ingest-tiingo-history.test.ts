import { describe, expect, it } from 'vitest';
import type { PolygonClient } from './backtest/index.js';
import { ingestTiingoHistory } from './ingest-tiingo-history.js';
import { CRYPTO_SYMBOLS, STAGE2_PINNED_WINDOW, STOCK_SYMBOLS } from './run-stage2.js';

const DAY_MS = 86_400_000;

describe('ingestTiingoHistory', () => {
  it('ingests every stage-2 symbol over the pinned window and prints each bar range', async () => {
    const start = STAGE2_PINNED_WINDOW.start.getTime();
    const requested: string[] = [];
    const client: PolygonClient = {
      async fetchAggregates(symbol) {
        requested.push(symbol);
        if (symbol !== 'SPY') return [];
        return [0, 1].map((i) => ({ t: start + i * DAY_MS, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }));
      },
    };
    const lines: string[] = [];

    await ingestTiingoHistory({ client, dbPath: ':memory:', print: (line) => lines.push(line) });

    expect(requested).toEqual([...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS]);
    expect(lines[0]).toMatch(/^Tiingo history ingest: 6 symbols over .* -> :memory:$/);
    expect(lines).toContain(
      `  SPY: 2 bars (${new Date(start).toISOString()} .. ${new Date(start + DAY_MS).toISOString()})`,
    );
    expect(lines).toContain('  QQQ: 0 bars (none .. none)');
    expect(lines.at(-1)).toBe('done — re-runs are free once the window is covered.');
  });
});
