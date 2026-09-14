/**
 * `NousMessagesClient` joined to `AnthropicLlmClient`.
 *
 * The wire-level cases live in `shared/llm/nous-chat.test.ts`. What this file
 * proves is the join: that the shape `NousMessagesClient` returns is the shape
 * `extractText`/`recordSpend` read, and — the one with money attached — that a
 * truncated completion is NOT retried by the layer above.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LlmInFlightRefusedError,
  NousAccountInFlightGate,
  UNGATED_LLM_IN_FLIGHT,
} from '../../../shared/llm/index.js';
import { AnthropicLlmClient } from './anthropic-client.js';
import { LlmAdmissionRefusedError, LlmRefusalError, LlmTruncatedError } from './errors.js';
import { classifyFailureCause } from './failure-cause.js';
import { NousMessagesClient } from './nous-messages-client.js';
import type { LlmSpendRecord, LlmSpendSink } from './spend-sink.js';
import type { LlmRequest } from './types.js';

const OPTIONS = {
  apiKey: 'test-fake-nous-key',
  baseUrl: 'https://nous.test/v1',
  gate: UNGATED_LLM_IN_FLIGHT,
};
const RETRY = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 };

function request(): LlmRequest<{ stance: string }> {
  return {
    prompt: 'take a stance',
    context: {
      analyst_views: [],
      attribution: { trace_id: 'trace-1', debate_id: 'debate-1', stage: 'debate' },
    },
    parseResponse: (text: string) => {
      // Must not throw: an unparseable draw is a `valid: false`, which the
      // layer above turns into a retryable `LlmMalformedResponseError`.
      try {
        const parsed = JSON.parse(text) as { stance?: unknown };
        return typeof parsed.stance === 'string'
          ? { valid: true as const, data: { stance: parsed.stance } }
          : { valid: false as const, reason: 'no stance' };
      } catch {
        return { valid: false as const, reason: 'not json' };
      }
    },
  };
}

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify(body), { status: 200, statusText: 'OK' }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Like `stubFetch`, but for the ttfb_ms/latency_ms join test below, which
 * needs to separate two phases of one fetch: time to headers (before
 * `fetchWithTimeout`'s promise settles) vs. additional time inside
 * `response.json()` reading the body. Returns a REAL `Response` (via the
 * global constructor) with `.json` overridden to advance the fake-timer
 * clock before resolving — no type-assertion cast to `Response` needed,
 * since a real `Response` instance already satisfies the full type. Same
 * construction `nous-chat.test.ts`'s `stubFetchWithTiming` uses; kept local
 * here rather than imported since `stubFetch` above is also a local copy
 * (each test file mocks the wire boundary independently).
 */
function stubFetchWithTiming(
  body: unknown,
  timing: { headerDelayMs: number; bodyDelayMs: number },
) {
  const fetchMock = vi.fn(async () => {
    vi.advanceTimersByTime(timing.headerDelayMs); // time to headers
    const response = new Response(JSON.stringify(body), { status: 200, statusText: 'OK' });
    const originalJson = response.json.bind(response);
    // `Response.json` is a read-only property in the ambient fetch types, so
    // a direct `response.json = ...` reassignment doesn't type-check.
    // `defineProperty` replaces the own binding at runtime the same way,
    // without needing a cast to route around the readonly check.
    Object.defineProperty(response, 'json', {
      value: async () => {
        vi.advanceTimersByTime(timing.bodyDelayMs); // additional time to read the body
        return originalJson();
      },
    });
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function client(spendSink?: LlmSpendSink) {
  return new AnthropicLlmClient(
    new NousMessagesClient(OPTIONS),
    { model: 'openai/gpt-5.6-luna', max_tokens: 1024, timeoutMs: 5_000, retry: RETRY },
    spendSink,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NousMessagesClient through AnthropicLlmClient', () => {
  it('parses a normal completion end to end', async () => {
    stubFetch({
      choices: [{ message: { content: '{"stance":"bullish"}' }, finish_reason: 'stop' }],
      model: 'openai/gpt-5.6-luna',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const response = await client().complete(request());

    expect(response.data).toEqual({ stance: 'bullish' });
  });

  it('meters the call against the priced model id', async () => {
    const records: LlmSpendRecord[] = [];
    stubFetch({
      choices: [{ message: { content: '{"stance":"bearish"}' }, finish_reason: 'stop' }],
      model: 'openai/gpt-5.6-luna',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await client({ record: (entry) => records.push(entry) }).complete(request());

    expect(records).toHaveLength(1);
    expect(records[0]?.model).toBe('openai/gpt-5.6-luna');
  });

  /**
   * End-to-end join for #1012: `nousChat` measures `ttfb_ms`, and it must
   * survive the trip through `NousMessagesClient.createMessage` and
   * `AnthropicLlmClient.recordSpend` to reach the spend sink — not just the
   * wire-level shape `nous-chat.test.ts` already covers.
   */
  it('carries ttfb_ms through to the spend sink, distinct from latency_ms', async () => {
    vi.useFakeTimers();
    try {
      const records: LlmSpendRecord[] = [];
      stubFetchWithTiming(
        {
          choices: [{ message: { content: '{"stance":"bullish"}' }, finish_reason: 'stop' }],
          model: 'openai/gpt-5.6-luna',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
        { headerDelayMs: 1_900, bodyDelayMs: 100 },
      );

      await client({ record: (entry) => records.push(entry) }).complete(request());

      expect(records).toHaveLength(1);
      expect(records[0]?.ttfb_ms).toBe(1_900);
      expect(records[0]?.latency_ms).toBe(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The whole reason `NousTruncatedError` exists.
   *
   * `retry.maxAttempts` is 3 here. A malformed response WOULD be retried three
   * times — correct for a bad sample, wrong for a truncation, which fails
   * identically at the same `max_tokens` and bills on every attempt. One fetch
   * call is the assertion.
   */
  it('does not retry a truncated completion', async () => {
    const fetchMock = stubFetch({
      choices: [{ message: { content: '{"stan' }, finish_reason: 'length' }],
      model: 'openai/gpt-5.6-luna',
      usage: { prompt_tokens: 10, completion_tokens: 1024 },
    });

    const error = await client()
      .complete(request())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmTruncatedError);
    expect((error as LlmTruncatedError).message).toMatch(/finish_reason="length"/);
    // #1394: the class survives the trip through `classifyProviderError`. It
    // did not before — the truncation arrived at every seam downstream as a
    // bare `LlmProviderError`, indistinguishable from a dead API key, so
    // `truncated` was a taxonomy member nothing could ever produce.
    expect((error as LlmTruncatedError).max_tokens).toBe(1024);
    expect((error as LlmTruncatedError).usage).toEqual({
      input_tokens: 10,
      output_tokens: 1024,
      cache_read_input_tokens: 0,
    });
    expect(classifyFailureCause(error)).toBe('truncated');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The same argument for a refusal (#1391). `retry.maxAttempts` is 3, and a
   * refusal's empty body parses no better on the third draw than the first —
   * the model declined the prompt, not the sample. One fetch call.
   */
  it('does not retry a refusal the provider signalled', async () => {
    const fetchMock = stubFetch({
      choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
      model: 'openai/gpt-5.6-luna',
      usage: { prompt_tokens: 900, completion_tokens: 3 },
    });

    const error = await client()
      .complete(request())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmRefusalError);
    // AC: the tokens the refused call burned are visible in the log. Nothing
    // meters them — a throw at the wire boundary never reaches `recordSpend` —
    // so the error is the only surface that carries them.
    expect((error as LlmRefusalError).usage).toEqual({
      input_tokens: 900,
      output_tokens: 3,
      cache_read_input_tokens: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a genuinely malformed sample, which a fresh draw can fix', async () => {
    // The contrast case: without it, "does not retry" could pass because
    // nothing retries at all.
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      const body = {
        choices: [
          {
            message: { content: call === 1 ? 'not json at all' : '{"stance":"bullish"}' },
            finish_reason: 'stop',
          },
        ],
        model: 'openai/gpt-5.6-luna',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      return new Response(JSON.stringify(body), { status: 200, statusText: 'OK' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await client().complete(request());

    expect(response.data).toEqual({ stance: 'bullish' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('NousMessagesClient behind the account in-flight gate (#1080)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function gatedClient(gate: NousAccountInFlightGate, gateBudgetMs: number) {
    return new AnthropicLlmClient(new NousMessagesClient({ ...OPTIONS, gate, gateBudgetMs }), {
      model: 'openai/gpt-5.6-luna',
      max_tokens: 1024,
      timeoutMs: 28_000,
      retry: RETRY,
    });
  }

  /**
   * Resolves each fetch only when the test says so, so "in flight" is
   * observable — and rejects on abort, the way a real `fetch` does, so the
   * cancellation path reaches the gate's `finally` rather than hanging.
   */
  function gatedFetch() {
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        releases.push(resolve);
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
      const body = {
        choices: [{ message: { content: '{"stance":"bullish"}' }, finish_reason: 'stop' }],
        model: 'openai/gpt-5.6-luna',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      return new Response(JSON.stringify(body), { status: 200, statusText: 'OK' });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, releases };
  }

  it('holds the second call off the wire until the first completes, at a cap of 1', async () => {
    const gate = new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: 5_800 });
    const { fetchMock, releases } = gatedFetch();
    const llm = gatedClient(gate, 28_000);

    const first = llm.complete(request());
    const second = llm.complete(request());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The mutation this kills: drop the gate (or raise the cap) and BOTH calls
    // are on the wire here.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releases[0]?.();
    await first;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releases[1]?.();
    await second;
  });

  it('refuses a call whose queue wait would outlast its budget, as gate_refused and off the wire', async () => {
    const gate = new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: 5_800 });
    const { fetchMock, releases } = gatedFetch();
    const llm = gatedClient(gate, 28_000);

    const admitted = [
      llm.complete(request()),
      llm.complete(request()),
      llm.complete(request()),
      llm.complete(request()),
    ];
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The fifth arrives with 3 queued ahead of it: an estimated 4 x 5,800 =
    // 23,200ms of waiting, which fits 28,000 on its own — and then a ~5,800ms
    // call of its own, which does not (23,200 + 5,800 = 29,000).
    const refused = await llm.complete(request()).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(LlmAdmissionRefusedError);
    expect(classifyFailureCause(refused)).toBe('gate_refused');
    // Never dispatched: a refusal costs no tokens and burns no deadline.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    for (let drained = 0; drained < admitted.length; drained += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(drained));
      releases[drained]?.();
    }
    await Promise.all(admitted);
  });

  /**
   * The race the gate's queue timer has to win. `callWithTimeout` starts its
   * `timeoutMs` timer BEFORE `createMessage`, and the gate is acquired inside
   * that call, so a gate that dropped its waiters AT `budgetMs` would always
   * lose: the queued waiter would be dropped carrying the outer timeout as its
   * abort reason and the call recorded as `timeout`. Then `queue_deadline` is
   * dead code, and the next measurement cannot tell a call held at the gate
   * from one whose deadline expired on the wire — the whole point of #1080's
   * instrumentation.
   *
   * It wins by construction rather than by a fudge constant: the drop fires at
   * `budgetMs - expectedCallMs`, a full expected call early. An earlier
   * revision bought the same reachability by shaving a 1,000 ms
   * `LLM_GATE_BUDGET_MARGIN_MS` off the budget at the composition root; the
   * timer change retired it, and this test is now run at a gate budget EQUAL
   * to the outer race to prove the margin is not what carries it.
   */
  it('lets the gate refuse a queued call before the outer race calls it a timeout', async () => {
    vi.useFakeTimers();
    try {
      const gate = new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: 5_800 });
      const { fetchMock } = gatedFetch();
      const llm = gatedClient(gate, 28_000);

      const first = llm.complete(request()).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const queued = llm.complete(request()).catch((error: unknown) => error);
      // Past the gate's drop at 28,000 - 5,800 = 22,200ms, but short of the
      // outer race at 28,000 — so the gate is unambiguously what settled it.
      await vi.advanceTimersByTimeAsync(22_200);

      const refused = await queued;
      expect(refused).toBeInstanceOf(LlmAdmissionRefusedError);
      expect((refused as LlmAdmissionRefusedError).reason).toBe('queue_deadline');
      expect(classifyFailureCause(refused)).toBe('gate_refused');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The first call is still holding the slot; drain it through its own
      // outer timeout so nothing is left pending.
      await vi.advanceTimersByTimeAsync(5_800);
      expect(classifyFailureCause(await first)).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the slot when the caller aborts a call in flight', async () => {
    const gate = new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: 5_800 });
    const { fetchMock } = gatedFetch();
    const llm = gatedClient(gate, 28_000);
    const controller = new AbortController();

    const cancelled = llm.complete({ ...request(), signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    controller.abort();
    await cancelled.catch(() => undefined);

    // The mutation this kills: release the slot on the success path only, and
    // the gate leaks a permit per cancelled call until nothing can run.
    const after = await gate.acquire({ budgetMs: 28_000 });
    after.release();
    expect(LlmInFlightRefusedError.name).toBe('LlmInFlightRefusedError');
  });
});
