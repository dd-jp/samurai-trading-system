import type { DebateLogger } from './debate-logger.js';
import {
  DebateBudgetExceededError,
  enforceLatencyBudget,
  LATENCY_BUDGET_MS,
  llmCallsPerDebate,
  MAX_ROUNDS_BY_ASSET_CLASS,
  type PartialDebateState,
} from './latency-budget.js';
import {
  LlmCancelledError,
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmTimeoutError,
} from './llm/errors.js';
import type { DebateResult } from './types.js';

const BAR = new Date('2026-07-15T10:00:00Z');

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
    bar_timestamp: BAR,
    read: true,
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
    round_verdicts: [{ round: 1, direction: 'bullish', confidence: 0.4 }],
    ...overrides,
  };
}

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
      bar: BAR,
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
      bar: BAR,
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
    expect(result.timed_out?.budget_ms).toBe(30_000);
  });

  it('enforces the 112s hard cap for stocks', async () => {
    const logger = makeLogger();

    const promise = enforceLatencyBudget({
      assetClass: 'stocks',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      bar: BAR,
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
    expect(result.timed_out?.budget_ms).toBe(112_000);
  });

  it('differentiates budgets by asset class (crypto times out before stocks would)', async () => {
    const logger = makeLogger();

    const cryptoPromise = enforceLatencyBudget({
      assetClass: 'crypto',
      trace_id: 'trace-1',
      debate_id: 'debate-crypto',
      bar: BAR,
      produceResult: () => new Promise(() => {}),
      getCurrentState: () => undefined,
      logger,
    });
    const stocksPromise = enforceLatencyBudget({
      assetClass: 'stocks',
      trace_id: 'trace-2',
      debate_id: 'debate-stocks',
      bar: BAR,
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
      bar: BAR,
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
    expect(result.timed_out).toEqual({ budget_ms: 30_000, elapsed_ms: 30_000, cause: 'budget' });
    expect(result.round_verdicts).toEqual(partial.round_verdicts);
  });

  it('falls back to a default low-confidence result when no partial state exists', async () => {
    const logger = makeLogger();

    const promise = enforceLatencyBudget({
      assetClass: 'crypto',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      bar: BAR,
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
    expect(result.timed_out).toEqual({ budget_ms: 30_000, elapsed_ms: 30_000, cause: 'budget' });
    expect(result.round_verdicts).toEqual([]);
  });

  it('logs the timeout event via DebateLogger.logTimeout', async () => {
    const logger = makeLogger();

    const promise = enforceLatencyBudget({
      assetClass: 'stocks',
      trace_id: 'trace-9',
      debate_id: 'debate-9',
      bar: BAR,
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
        elapsed_ms: 112_000,
        budget_ms: 112_000,
      }),
    );
  });

  it('hands the debate a signal that is not aborted while it is within budget', async () => {
    const logger = makeLogger();
    let seen: AbortSignal | undefined;

    const promise = enforceLatencyBudget({
      assetClass: 'crypto',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      bar: BAR,
      produceResult: (signal) => {
        seen = signal;
        return resolvesAfter(5_000, makeResult());
      },
      getCurrentState: () => undefined,
      logger,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  it('aborts the debate signal when the budget fires (#347)', async () => {
    const logger = makeLogger();
    let seen: AbortSignal | undefined;

    const promise = enforceLatencyBudget({
      assetClass: 'crypto',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      bar: BAR,
      produceResult: (signal) => {
        seen = signal;
        return new Promise(() => {});
      },
      getCurrentState: () => undefined,
      logger,
    });

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
    await promise;

    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(DebateBudgetExceededError);
    expect(seen?.reason.budget_ms).toBe(LATENCY_BUDGET_MS.crypto);
  });

  it('aborts before reading the partial state, so no further work can be recorded', async () => {
    const logger = makeLogger();
    let seen: AbortSignal | undefined;
    let abortedWhenStateRead: boolean | undefined;

    const promise = enforceLatencyBudget({
      assetClass: 'crypto',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      bar: BAR,
      produceResult: (signal) => {
        seen = signal;
        return new Promise(() => {});
      },
      getCurrentState: () => {
        abortedWhenStateRead = seen?.aborted;
        return makePartialState();
      },
      logger,
    });

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
    const result = await promise;

    expect(abortedWhenStateRead).toBe(true);
    expect(result.synthesis).toBe(makePartialState().synthesis);
  });

  it('clears the budget timer when the debate wins the race', async () => {
    const logger = makeLogger();

    const promise = enforceLatencyBudget({
      assetClass: 'stocks',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      bar: BAR,
      produceResult: () => resolvesAfter(1_000, makeResult()),
      getCurrentState: () => undefined,
      logger,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('swallows the cancelled debate rejection without logging anything extra', async () => {
    const logger = makeLogger();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const promise = enforceLatencyBudget({
        assetClass: 'crypto',
        trace_id: 'trace-1',
        debate_id: 'debate-1',
        bar: BAR,
        produceResult: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
          }),
        getCurrentState: () => undefined,
        logger,
      });

      await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
      const result = await promise;
      await vi.advanceTimersByTimeAsync(0);

      expect(result.timed_out).toBeDefined();
      expect(logger.logTimeout).toHaveBeenCalledTimes(1);
      expect(logger.logAnalystFailure).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('still propagates a debate failure that arrives before the budget fires', async () => {
    const logger = makeLogger();

    const promise = enforceLatencyBudget({
      assetClass: 'crypto',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      bar: BAR,
      produceResult: () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('mediator exploded')), 1_000);
        }),
      getCurrentState: () => undefined,
      logger,
    });

    const rejects = expect(promise).rejects.toThrow('mediator exploded');
    await vi.advanceTimersByTimeAsync(1_000);
    await rejects;
  });

  describe('an LlmError from produceResult, before the budget fires (#1380)', () => {
    it('degrades to the low-confidence fallback when no round had completed', async () => {
      const logger = makeLogger();

      const promise = enforceLatencyBudget({
        assetClass: 'stocks',
        trace_id: 'trace-1',
        debate_id: 'debate-1',
        bar: BAR,
        produceResult: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new LlmTimeoutError('LLM call exceeded 28000ms')), 56_000);
          }),
        getCurrentState: () => undefined,
        logger,
      });

      const settled = expect(promise).resolves.toEqual(
        expect.objectContaining({
          converged: false,
          confidence: 0,
          direction: 'neutral',
          rounds_completed: 0,
          debate_id: 'debate-1',
        }),
      );
      await vi.advanceTimersByTimeAsync(56_000);
      await settled;
    });

    it('uses the mediator synthesis in progress, when a round had already completed', async () => {
      const logger = makeLogger();
      const partial = makePartialState();

      const promise = enforceLatencyBudget({
        assetClass: 'stocks',
        trace_id: 'trace-1',
        debate_id: 'debate-1',
        bar: BAR,
        produceResult: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new LlmTimeoutError('LLM call exceeded 28000ms')), 56_000);
          }),
        getCurrentState: () => partial,
        logger,
      });

      const settled = expect(promise).resolves.toEqual(
        expect.objectContaining({
          synthesis: partial.synthesis,
          position: partial.position,
          confidence: partial.confidence,
          rounds_completed: partial.rounds_completed,
          converged: false,
        }),
      );
      await vi.advanceTimersByTimeAsync(56_000);
      await settled;
    });

    it('is recorded through the SAME degraded convention as a genuine budget timeout', async () => {
      const logger = makeLogger();

      const promise = enforceLatencyBudget({
        assetClass: 'stocks',
        trace_id: 'trace-1',
        debate_id: 'debate-1',
        bar: BAR,
        produceResult: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new LlmTimeoutError('LLM call exceeded 28000ms')), 56_000);
          }),
        getCurrentState: () => undefined,
        logger,
      });

      const settlePromise = promise;
      await vi.advanceTimersByTimeAsync(56_000);
      const result = await settlePromise;

      expect(result.timed_out).toBeDefined();
      expect(result.timed_out?.budget_ms).toBe(LATENCY_BUDGET_MS.stocks);
    });

    it('pins the discriminator: cause is "llm_failure" here, "budget" on a genuine timeout', async () => {
      const logger = makeLogger();

      const llmFailurePromise = enforceLatencyBudget({
        assetClass: 'stocks',
        trace_id: 'trace-1',
        debate_id: 'debate-1',
        bar: BAR,
        produceResult: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new LlmTimeoutError('LLM call exceeded 28000ms')), 56_000);
          }),
        getCurrentState: () => undefined,
        logger,
      });
      await vi.advanceTimersByTimeAsync(56_000);
      const llmFailureResult = await llmFailurePromise;

      const budgetPromise = enforceLatencyBudget({
        assetClass: 'crypto',
        trace_id: 'trace-2',
        debate_id: 'debate-2',
        bar: BAR,
        produceResult: () => new Promise(() => {}),
        getCurrentState: () => undefined,
        logger,
      });
      await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
      const budgetResult = await budgetPromise;

      expect(llmFailureResult.timed_out?.cause).toBe('llm_failure');
      expect(budgetResult.timed_out?.cause).toBe('budget');
    });

    it('logs a reason naming the LLM failure, distinct from a genuine budget expiry', async () => {
      const logger = makeLogger();

      const promise = enforceLatencyBudget({
        assetClass: 'stocks',
        trace_id: 'trace-1',
        debate_id: 'debate-1',
        bar: BAR,
        produceResult: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new LlmTimeoutError('LLM call exceeded 28000ms')), 56_000);
          }),
        getCurrentState: () => undefined,
        logger,
      });

      await vi.advanceTimersByTimeAsync(56_000);
      await promise;

      expect(logger.logTimeout).toHaveBeenCalledTimes(1);
      expect(logger.logTimeout).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.stringContaining('LLM call exceeded 28000ms'),
        }),
      );
      expect(logger.logTimeout).not.toHaveBeenCalledWith(
        expect.objectContaining({
          reason:
            'latency budget exceeded: no partial synthesis available, using low-confidence fallback',
        }),
      );
    });

    it('aborts the debate signal with the LlmTimeoutError, so a concurrent sibling call is cancelled too', async () => {
      const logger = makeLogger();
      let seen: AbortSignal | undefined;

      const promise = enforceLatencyBudget({
        assetClass: 'stocks',
        trace_id: 'trace-1',
        debate_id: 'debate-1',
        bar: BAR,
        produceResult: (signal) => {
          seen = signal;
          return new Promise((_resolve, reject) => {
            setTimeout(() => reject(new LlmTimeoutError('LLM call exceeded 28000ms')), 56_000);
          });
        },
        getCurrentState: () => undefined,
        logger,
      });

      await vi.advanceTimersByTimeAsync(56_000);
      await promise;

      expect(seen?.aborted).toBe(true);
      expect(seen?.reason).toBeInstanceOf(LlmTimeoutError);
    });

    it('clears the budget timer rather than leaving it pending', async () => {
      const logger = makeLogger();

      const promise = enforceLatencyBudget({
        assetClass: 'stocks',
        trace_id: 'trace-1',
        debate_id: 'debate-1',
        bar: BAR,
        produceResult: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new LlmTimeoutError('LLM call exceeded 28000ms')), 56_000);
          }),
        getCurrentState: () => undefined,
        logger,
      });

      await vi.advanceTimersByTimeAsync(56_000);
      await promise;

      expect(vi.getTimerCount()).toBe(0);
    });

    it('degrades on an LlmRateLimitError too, not only LlmTimeoutError', async () => {
      const logger = makeLogger();

      const promise = enforceLatencyBudget({
        assetClass: 'stocks',
        trace_id: 'trace-1',
        debate_id: 'debate-1',
        bar: BAR,
        produceResult: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new LlmRateLimitError('rate limited by provider')), 56_000);
          }),
        getCurrentState: () => undefined,
        logger,
      });

      await vi.advanceTimersByTimeAsync(56_000);
      const result = await promise;

      expect(result.timed_out?.cause).toBe('llm_failure');
    });

    it('degrades on an LlmMalformedResponseError too, not only LlmTimeoutError', async () => {
      const logger = makeLogger();

      const promise = enforceLatencyBudget({
        assetClass: 'stocks',
        trace_id: 'trace-1',
        debate_id: 'debate-1',
        bar: BAR,
        produceResult: () =>
          new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(new LlmMalformedResponseError('missing position field')),
              56_000,
            );
          }),
        getCurrentState: () => undefined,
        logger,
      });

      await vi.advanceTimersByTimeAsync(56_000);
      const result = await promise;

      expect(result.timed_out?.cause).toBe('llm_failure');
    });

    it.each([
      [
        'LlmProviderError',
        () => new LlmProviderError('502 from provider'),
        '502 from provider',
      ] as const,
      [
        'LlmCancelledError',
        () => new LlmCancelledError('cancelled by an unrelated caller'),
        'cancelled by an unrelated caller',
      ] as const,
      ['a generic bug', () => new Error('mediator exploded'), 'mediator exploded'] as const,
    ])(
      'still crashes the pass on %s, deliberately NOT absorbed here',
      async (_name, makeError, expectedMessage) => {
        const logger = makeLogger();

        const promise = enforceLatencyBudget({
          assetClass: 'stocks',
          trace_id: 'trace-1',
          debate_id: 'debate-1',
          bar: BAR,
          produceResult: () =>
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(makeError()), 1_000);
            }),
          getCurrentState: () => undefined,
          logger,
        });

        const rejects = expect(promise).rejects.toThrow(expectedMessage);
        await vi.advanceTimersByTimeAsync(1_000);
        await rejects;
      },
    );
  });

  it('does not log a timeout event when the debate completes in time', async () => {
    const logger = makeLogger();

    const promise = enforceLatencyBudget({
      assetClass: 'crypto',
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      bar: BAR,
      produceResult: () => resolvesAfter(1_000, makeResult()),
      getCurrentState: () => undefined,
      logger,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(logger.logTimeout).not.toHaveBeenCalled();
  });
});

describe('the stocks debate budget against the calls the debate issues (#1080)', () => {
  it('counts three persona calls per round plus one disagreement detection per debate', () => {
    expect(llmCallsPerDebate(1)).toBe(4);
    expect(llmCallsPerDebate(3)).toBe(10);
  });

  it('affords every sequential call a stocks debate issues at the measured per-call ceiling', () => {
    expect(MAX_ROUNDS_BY_ASSET_CLASS.stocks).toBe(1);
    expect(LATENCY_BUDGET_MS.stocks).toBe(112_000);
  });
});
