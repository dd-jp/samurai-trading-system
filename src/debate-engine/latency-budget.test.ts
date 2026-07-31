import type { DebateLogger } from './debate-logger.js';
import {
  enforceLatencyBudget,
  LATENCY_BUDGET_MS,
  type PartialDebateState,
} from './latency-budget.js';
import type { DebateResult } from './types.js';

function makeLogger(): DebateLogger {
  return {
    logInputs: vi.fn(),
    logRound: vi.fn(),
    logOutput: vi.fn(),
    logLatency: vi.fn(),
    logTimeout: vi.fn(),
    logAnalystFailure: vi.fn(),
    logDisagreement: vi.fn(),
  };
}

function makeResult(overrides: Partial<DebateResult> = {}): DebateResult {
  return {
    synthesis: 'Bulls have the stronger case this bar.',
    position: 'Buy',
    confidence: 0.7,
    contributions: [],
    disagreement_summary: 'Bear cites overextension; bull cites volume confirmation.',
    open_items: [],
    converged: true,
    rounds_completed: 2,
    latency_ms: 8000,
    direction: 'bullish',
    debate_id: 'debate-1',
    ...overrides,
  };
}

function makePartialState(overrides: Partial<PartialDebateState> = {}): PartialDebateState {
  return {
    synthesis: 'Bulls slightly ahead after round 1; bear has not yet responded.',
    position: 'Lean buy',
    confidence: 0.4,
    contributions: [],
    disagreement_summary: 'Round 1 only; disagreement not yet fully surfaced.',
    open_items: ['bear rebuttal outstanding'],
    rounds_completed: 1,
    direction: 'bullish',
    debate_id: 'debate-1',
    ...overrides,
  };
}

/** Resolves after `ms` of (fake) wall-clock time. */
function resolvesAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

describe('enforceLatencyBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the produced result unchanged when it completes within budget', async () => {
    const logger = makeLogger();
    const result = makeResult();

    const promise = enforceLatencyBudget({
      assetClass: 'crypto',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      produceResult: () => resolvesAfter(5_000, result),
      getCurrentState: () => undefined,
      logger,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toEqual(result);
    expect(logger.logTimeout).not.toHaveBeenCalled();
  });

  it('enforces the 15s hard cap for crypto', async () => {
    const logger = makeLogger();

    const promise = enforceLatencyBudget({
      assetClass: 'crypto',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      produceResult: () => new Promise(() => {}),
      getCurrentState: () => undefined,
      logger,
    });

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto - 1);
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(result.converged).toBe(false);
    expect(result.timed_out?.budget_ms).toBe(15_000);
  });

  it('enforces the 60s hard cap for stocks', async () => {
    const logger = makeLogger();

    const promise = enforceLatencyBudget({
      assetClass: 'stocks',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      produceResult: () => new Promise(() => {}),
      getCurrentState: () => undefined,
      logger,
    });

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.stocks - 1);
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(result.converged).toBe(false);
    expect(result.timed_out?.budget_ms).toBe(60_000);
  });

  it('differentiates budgets by asset class (crypto times out before stocks would)', async () => {
    const logger = makeLogger();

    const cryptoPromise = enforceLatencyBudget({
      assetClass: 'crypto',
      trace_id: 'trace-1',
      debate_id: 'debate-crypto',
      produceResult: () => new Promise(() => {}),
      getCurrentState: () => undefined,
      logger,
    });
    const stocksPromise = enforceLatencyBudget({
      assetClass: 'stocks',
      trace_id: 'trace-2',
      debate_id: 'debate-stocks',
      produceResult: () => new Promise(() => {}),
      getCurrentState: () => undefined,
      logger,
    });

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
    const cryptoResult = await cryptoPromise;
    expect(cryptoResult.timed_out).toBeDefined();

    let stocksSettled = false;
    stocksPromise.then(() => {
      stocksSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stocksSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.stocks - LATENCY_BUDGET_MS.crypto);
    const stocksResult = await stocksPromise;
    expect(stocksResult.timed_out).toBeDefined();
  });

  it('uses the mediator synthesis in progress on timeout, when available', async () => {
    const logger = makeLogger();
    const partial = makePartialState();

    const promise = enforceLatencyBudget({
      assetClass: 'crypto',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      produceResult: () => new Promise(() => {}),
      getCurrentState: () => partial,
      logger,
    });

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
    const result = await promise;

    expect(result.synthesis).toBe(partial.synthesis);
    expect(result.position).toBe(partial.position);
    expect(result.confidence).toBe(partial.confidence);
    expect(result.rounds_completed).toBe(partial.rounds_completed);
    expect(result.open_items).toEqual(partial.open_items);
    expect(result.converged).toBe(false);
    expect(result.timed_out).toEqual({ budget_ms: 15_000, elapsed_ms: 15_000 });
  });

  it('falls back to a default low-confidence result when no partial state exists', async () => {
    const logger = makeLogger();

    const promise = enforceLatencyBudget({
      assetClass: 'crypto',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      produceResult: () => new Promise(() => {}),
      getCurrentState: () => undefined,
      logger,
    });

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
    const result = await promise;

    expect(result.converged).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.direction).toBe('neutral');
    expect(result.rounds_completed).toBe(0);
    expect(result.debate_id).toBe('debate-1');
    expect(result.timed_out).toEqual({ budget_ms: 15_000, elapsed_ms: 15_000 });
  });

  it('logs the timeout event via DebateLogger.logTimeout', async () => {
    const logger = makeLogger();

    const promise = enforceLatencyBudget({
      assetClass: 'stocks',
      trace_id: 'trace-9',
      debate_id: 'debate-9',
      produceResult: () => new Promise(() => {}),
      getCurrentState: () => undefined,
      logger,
    });

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.stocks);
    await promise;

    expect(logger.logTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: 'trace-9',
        debate_id: 'debate-9',
        elapsed_ms: 60_000,
        budget_ms: 60_000,
      }),
    );
  });

  it('does not log a timeout event when the debate completes in time', async () => {
    const logger = makeLogger();

    const promise = enforceLatencyBudget({
      assetClass: 'crypto',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      produceResult: () => resolvesAfter(1_000, makeResult()),
      getCurrentState: () => undefined,
      logger,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(logger.logTimeout).not.toHaveBeenCalled();
  });
});
