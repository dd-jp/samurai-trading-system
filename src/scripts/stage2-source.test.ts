import { FreeStackAggregatesClient, HttpPolygonClient } from '../cost-model-backtest/index.js';
import {
  resolveStage2Source,
  STAGE2_FREE_STACK_WINDOW,
  STAGE2_PINNED_WINDOW,
} from './stage2-source.js';

const CREDS = {
  ALPACA_API_KEY: 'fake-key',
  ALPACA_API_SECRET: 'fake-secret',
  POLYGON_API_KEY: 'fake-polygon-key',
};

describe('resolveStage2Source', () => {
  it('defaults to Polygon and the pinned two-year window', () => {
    const { client, window, label } = resolveStage2Source(CREDS);

    expect(client).toBeInstanceOf(HttpPolygonClient);
    expect(window).toEqual(STAGE2_PINNED_WINDOW);
    expect(label).toBe('polygon');
  });

  it('selects the free stack and its ten-year window when asked', () => {
    const { client, window, label } = resolveStage2Source({
      ...CREDS,
      STAGE2_SOURCE: 'free-stack',
    });

    expect(client).toBeInstanceOf(FreeStackAggregatesClient);
    expect(window).toEqual(STAGE2_FREE_STACK_WINDOW);
    expect(label).toBe('free-stack');
  });

  it('rejects an unrecognised source rather than silently falling back', () => {
    expect(() => resolveStage2Source({ ...CREDS, STAGE2_SOURCE: 'tiingo' })).toThrow(
      /STAGE2_SOURCE/,
    );
  });

  it('gives the free stack a materially longer window than the pinned one', () => {
    const pinnedYears =
      (STAGE2_PINNED_WINDOW.end.getTime() - STAGE2_PINNED_WINDOW.start.getTime()) /
      (365 * 86_400_000);
    const freeYears =
      (STAGE2_FREE_STACK_WINDOW.end.getTime() - STAGE2_FREE_STACK_WINDOW.start.getTime()) /
      (365 * 86_400_000);

    expect(pinnedYears).toBeCloseTo(5, 0);
    expect(freeYears).toBeGreaterThan(10);
  });

  it('ends both windows at the same instant so verdicts are comparable', () => {
    expect(STAGE2_FREE_STACK_WINDOW.end).toEqual(STAGE2_PINNED_WINDOW.end);
  });
});
