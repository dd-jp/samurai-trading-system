/**
 * `NousMessagesClient` joined to `AnthropicLlmClient`.
 *
 * The wire-level cases live in `shared/llm/nous-chat.test.ts`. What this file
 * proves is the join: that the shape `NousMessagesClient` returns is the shape
 * `extractText`/`recordSpend` read, and — the one with money attached — that a
 * truncated completion is NOT retried by the layer above.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicLlmClient } from './anthropic-client.js';
import { LlmRefusalError } from './errors.js';
import { NousMessagesClient } from './nous-messages-client.js';
import type { LlmSpendRecord, LlmSpendSink } from './spend-sink.js';
import type { LlmRequest } from './types.js';

const OPTIONS = { apiKey: 'test-fake-nous-key', baseUrl: 'https://nous.test/v1' };
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

    await expect(client().complete(request())).rejects.toThrow(/finish_reason="length"/);
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
