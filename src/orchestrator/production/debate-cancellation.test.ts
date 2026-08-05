/**
 * End-to-end cancellation proof for #347 — the composed chain
 * `enforceLatencyBudget` -> `runDebate` -> `buildDebatePersonas` ->
 * `AnthropicLlmClient` -> `AnthropicHttpMessagesClient` -> `fetch`.
 *
 * The unit tests beside each module pin their own seam; this file is the only
 * place that proves the seams JOIN UP — that the signal `enforceLatencyBudget`
 * creates is the signal the real `fetch` init carries, and that aborting it
 * both kills the in-flight request and stops the round loop from issuing more.
 * A per-module test cannot show that: every one of them could pass while the
 * signal is dropped on the floor one layer down.
 *
 * No network and no wall-clock: `fetch` is stubbed (`vi.stubGlobal`, the same
 * seam `anthropic-http-client.test.ts` uses) and every duration is fake-timer
 * driven.
 */

import type { DebateLogger } from '../../debate-engine/debate-logger.js';
import { enforceLatencyBudget, LATENCY_BUDGET_MS, runDebate } from '../../debate-engine/index.js';
import { AnthropicLlmClient } from '../../debate-engine/llm/anthropic-client.js';
import { AnthropicHttpMessagesClient } from '../../debate-engine/llm/anthropic-http-client.js';
import type { AnalystView } from '../../debate-engine/types.js';
import type { Clock } from '../../shared/index.js';
import { buildDebatePersonas, type DebatePersonas } from './debate-adapter.js';

const FAKE_KEY = 'test-fake-anthropic-key';

/**
 * `converged: false` on purpose: the debate then runs the full 3-round cap,
 * which is the "equivalent one that runs to the cap" the call-count assertion
 * measures the timed-out run against.
 */
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

/**
 * A `fetch` that takes `ms` of fake time to answer and rejects the moment its
 * `init.signal` aborts — i.e. it behaves like the real thing, which is what
 * makes "aborted, not merely ignored" observable at this layer.
 */
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
            json: async () => ({ content: [{ type: 'text', text: RESPONSE_TEXT }] }),
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
    // 60s network backstop, well outside anything these tests exercise, so the
    // only thing that ever cancels a call here is the latency budget.
    new AnthropicHttpMessagesClient({ apiKey: FAKE_KEY, timeoutMs: 60_000 }),
    {
      model: 'claude-haiku-4-5-20251001',
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
    // 1s per call * (3 rounds * 3 personas + 1 disagreement call) = 10s < 15s budget.
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
    // 8s per call: bull answers at 8s, bear is still in flight when the 15s
    // budget fires. Two calls issued, versus ten for the run-to-cap case.
    const fetches = stubSlowFetch(8_000);
    const logger = makeLogger();
    const personas = buildDebatePersonas(buildLlmClient(), 'trace-1', CLOCK);

    const promise = runBudgetedDebate(personas, logger);
    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
    const result = await promise;

    expect(result.timed_out).toEqual({ budget_ms: 15_000, elapsed_ms: 15_000 });
    expect(fetches.calls()).toBe(2);

    // The decisive assertion: no call is issued AFTER the budget fires. Without
    // cancellation the abandoned chain runs on and reaches ten.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetches.calls()).toBe(2);
  });

  it('aborts the in-flight request at the fetch layer, not merely ignores it', async () => {
    const fetches = stubSlowFetch(8_000);
    const logger = makeLogger();
    const personas = buildDebatePersonas(buildLlmClient(), 'trace-1', CLOCK);

    const promise = runBudgetedDebate(personas, logger);
    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.crypto);
    await promise;

    // The signal handed to the second (in-flight) fetch is aborted; the first,
    // which had already answered, is not left dangling in an aborted state that
    // some later retry could observe.
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

    // `logTimeout` is the one event a timed-out debate is entitled to. A
    // cancellation is a deliberate act, not a fault: it must not also surface
    // as an analyst failure, which is what an operator watching a 14-day soak
    // would otherwise learn to ignore.
    expect(logger.logAnalystFailure).not.toHaveBeenCalled();
    expect(logger.logDisagreement).not.toHaveBeenCalled();
    expect(logger.logRound).not.toHaveBeenCalled();
  });

  it('leaves no timer behind once the debate settles', async () => {
    stubSlowFetch(1_000);
    const logger = makeLogger();
    const personas = buildDebatePersonas(buildLlmClient(), 'trace-1', CLOCK);

    const promise = runBudgetedDebate(personas, logger);
    // Exactly the 10s the ten calls take — stopping SHORT of the 15s budget, so
    // the budget timer is still pending unless it was explicitly cleared.
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;
    await vi.advanceTimersByTimeAsync(0);

    // The budget timer is cleared when the debate wins the race; an unfired
    // timer per tick is its own slow leak over an unattended soak.
    expect(vi.getTimerCount()).toBe(0);
  });
});
