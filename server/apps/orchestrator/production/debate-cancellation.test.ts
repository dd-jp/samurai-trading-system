
import type {
  AnalystView,
  DebateLogger,
  DebatePersonas,
} from '../../../pipeline/debate-engine/index.js';
import {
  AnthropicLlmClient,
  enforceLatencyBudget,
  LATENCY_BUDGET_MS,
  NousMessagesClient,
  runDebate,
} from '../../../pipeline/debate-engine/index.js';
import type { Clock } from '../../../shared/index.js';
import { UNGATED_LLM_IN_FLIGHT } from '../../../shared/llm/index.js';
import { buildDebatePersonas } from './debate-adapter.js';

const FAKE_KEY = 'test-fake-nous-key';
const FAKE_BASE_URL = 'https://nous.test/v1';

const RESPONSE_TEXT = JSON.stringify({
  stance: 'bullish',
  rationale: 'cancellation fixture',
  converged: false,
  summary: 'no material disagreement',
  conflicts: [],
});

const CLOCK: Clock = { now: () => new Date('2026-08-04T12:00:00.000Z') };

function makeView(analyst_id = 'a1'): AnalystView {
  return {
    analyst_id,
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.8,
    key_points: ['uptrend intact'],
    timestamp: new Date('2026-08-04T12:00:00.000Z'),
    trace_id: 'trace-1',
  };
}

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

function stubSlowFetch(ms: number): { signals: AbortSignal[]; calls: () => number } {
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    signals.push(signal);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
              choices: [{ message: { content: RESPONSE_TEXT }, finish_reason: 'stop' }],
              model: 'openai/gpt-5.6-luna',
              usage: { prompt_tokens: 10, completion_tokens: 20 },
            }),
          } as Response),
        ms,
      );
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { signals, calls: () => fetchMock.mock.calls.length };
}

function buildLlmClient(): AnthropicLlmClient {
  return new AnthropicLlmClient(
    new NousMessagesClient({
      apiKey: FAKE_KEY,
      baseUrl: FAKE_BASE_URL,
      timeoutMs: 60_000,
      gate: UNGATED_LLM_IN_FLIGHT,
    }),
    {
      model: 'openai/gpt-5.6-luna',
      max_tokens: 1024,
      timeoutMs: 60_000,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    },
  );
}

function runBudgetedDebate(personas: DebatePersonas, logger: DebateLogger) {
  return enforceLatencyBudget({
    assetClass: 'crypto',
    trace_id: 'trace-1',
    debate_id: 'debate-1',
    bar: CLOCK.now(),
    produceResult: (signal) =>
      runDebate(
        { views: [makeView('a1'), makeView('a2')], instrument: 'BTC-USD', bar: CLOCK.now() },
        personas,
        { signal },
      ),
    getCurrentState: () => undefined,
    logger,
  });
}

describe('debate cancellation (#347)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('runs every round to the cap when each call is fast enough', async () => {
    const fetches = stubSlowFetch(1_000);
    const logger = makeLogger();
    const personas = buildDebatePersonas(buildLlmClient(), 'trace-1', CLOCK);

    const promise = runBudgetedDebate(personas, logger);
    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
    const result = await promise;

    expect(result.timed_out).toBeUndefined();
    expect(result.rounds_completed).toBe(3);
    expect(fetches.calls()).toBe(10);
    expect(logger.logTimeout).not.toHaveBeenCalled();
  });

  it('issues strictly fewer LLM calls when the budget fires in round 1', async () => {
    const fetches = stubSlowFetch(16_000);
    const logger = makeLogger();
    const personas = buildDebatePersonas(buildLlmClient(), 'trace-1', CLOCK);

    const promise = runBudgetedDebate(personas, logger);
    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
    const result = await promise;

    expect(result.timed_out).toEqual({ budget_ms: 30_000, elapsed_ms: 30_000, cause: 'budget' });
    expect(fetches.calls()).toBe(2);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetches.calls()).toBe(2);
  });

  it('aborts the in-flight request at the fetch layer, not merely ignores it', async () => {
    const fetches = stubSlowFetch(16_000);
    const logger = makeLogger();
    const personas = buildDebatePersonas(buildLlmClient(), 'trace-1', CLOCK);

    const promise = runBudgetedDebate(personas, logger);
    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
    await promise;

    expect(fetches.signals).toHaveLength(2);
    expect(fetches.signals[1]?.aborted).toBe(true);
  });

  it('returns the low-confidence fallback unchanged from the caller point of view', async () => {
    stubSlowFetch(8_000);
    const logger = makeLogger();
    const personas = buildDebatePersonas(buildLlmClient(), 'trace-1', CLOCK);

    const promise = runBudgetedDebate(personas, logger);
    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
    const result = await promise;

    expect(result.converged).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.direction).toBe('neutral');
    expect(result.rounds_completed).toBe(0);
    expect(result.open_items).toEqual(['debate did not complete within latency budget']);
    expect(logger.logTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not report the cancellation as an analyst failure or any other log event', async () => {
    stubSlowFetch(8_000);
    const logger = makeLogger();
    const personas = buildDebatePersonas(buildLlmClient(), 'trace-1', CLOCK);

    const promise = runBudgetedDebate(personas, logger);
    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
    await promise;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(logger.logAnalystFailure).not.toHaveBeenCalled();
    expect(logger.logDisagreement).not.toHaveBeenCalled();
    expect(logger.logRound).not.toHaveBeenCalled();
  });

  it('leaves no timer behind once the debate settles', async () => {
    stubSlowFetch(1_000);
    const logger = makeLogger();
    const personas = buildDebatePersonas(buildLlmClient(), 'trace-1', CLOCK);

    const promise = runBudgetedDebate(personas, logger);
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
  });
});
