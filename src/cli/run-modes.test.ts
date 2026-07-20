/**
 * `runOnce`/`runWatch` (#99 acceptance criteria): `runOnce` calls each render
 * function exactly once; `runWatch` redraws on the configured interval.
 * Asserts against spy `CLIViews` functions and a fake `QueryStore`
 * (cli-spec.md "Testing Decisions") — no real terminal/store behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOnce, runWatch } from './run-modes.js';
import type { CLIViews, QueryStore } from './types.js';

function fakeStore(overrides: Partial<QueryStore> = {}): QueryStore {
  return {
    getRecentDebates: () => [],
    getTickStatus: () => null,
    getOpenPositions: () => [],
    getVerdictHistory: () => [],
    getAnalystWeights: () => ({}),
    getAttribution: () => ({}),
    getDailyMetrics: () => {
      throw new Error('not used in these tests');
    },
    getMark: () => {
      throw new Error('not used in these tests');
    },
    ...overrides,
  };
}

function fakeViews(): CLIViews {
  return {
    renderPositions: vi.fn(() => 'positions'),
    renderDebates: vi.fn(() => 'debates'),
    renderVerdicts: vi.fn(() => 'verdicts'),
    renderPerformance: vi.fn(() => 'performance'),
  };
}

describe('runOnce', () => {
  it('calls each render function exactly once', () => {
    const views = fakeViews();
    const store = fakeStore();

    runOnce(views, store);

    expect(views.renderPositions).toHaveBeenCalledTimes(1);
    expect(views.renderDebates).toHaveBeenCalledTimes(1);
    expect(views.renderVerdicts).toHaveBeenCalledTimes(1);
    expect(views.renderPerformance).toHaveBeenCalledTimes(1);
  });

  it('prints the output of each render function', () => {
    const views = fakeViews();
    const store = fakeStore();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    runOnce(views, store);

    expect(logSpy.mock.calls.flat()).toEqual(
      expect.arrayContaining(['positions', 'debates', 'verdicts', 'performance']),
    );
    logSpy.mockRestore();
  });
});

describe('runWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'clear').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('redraws immediately and then on each configured interval', () => {
    const views = fakeViews();
    const store = fakeStore();

    runWatch(views, store, 5000);
    expect(views.renderPositions).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(views.renderPositions).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(5000);
    expect(views.renderPositions).toHaveBeenCalledTimes(3);
  });

  it('does not redraw before the interval elapses', () => {
    const views = fakeViews();
    const store = fakeStore();

    runWatch(views, store, 5000);
    vi.advanceTimersByTime(4999);

    expect(views.renderPositions).toHaveBeenCalledTimes(1);
  });
});
