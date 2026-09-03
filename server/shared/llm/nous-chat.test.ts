/**
 * `nous-chat.ts` — the single wire between this system and a model.
 *
 * The cases worth pinning are the ones that cost money quietly rather than
 * failing loudly: a truncated completion that would otherwise be retried at
 * the same budget, and a provider-echoed model id that would land the row
 * unpriced (and an unpriced row does not count against the spend cap).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NousApiError, NousTruncatedError, nousChat } from './nous-chat.js';

const OPTIONS = { apiKey: 'test-fake-nous-key', baseUrl: 'https://nous.test/v1' };
const REQUEST = {
  model: 'openai/gpt-5.6-luna',
  max_tokens: 1024,
  messages: [{ role: 'user' as const, content: 'hello' }],
};

/**
 * Builds a real `Response` (via the global constructor) for `status`/`ok` to
 * come from — `ok` is the constructor's own derivation from `status`
 * (200-299), not a separately-settable field, so every call site here passes
 * a `status` that already implies the `ok` it wants. `jsonOverride` covers
 * the one case (an unparseable 2xx body) that needs `.json()` to behave
 * differently than "resolve with the stringified `body`"; `Response.json` is
 * read-only in the ambient fetch types, so `defineProperty` replaces the own
 * binding at runtime instead of a direct reassignment, without needing a
 * cast to route around the readonly check.
 */
function stubFetch(
  body: unknown,
  init: { status?: number; jsonOverride?: () => Promise<unknown> } = {},
) {
  const fetchMock = vi.fn(async () => {
    const response = new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      statusText: 'OK',
    });
    if (init.jsonOverride) {
      Object.defineProperty(response, 'json', { value: init.jsonOverride });
    }
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Like `stubFetch`, but for the `ttfb_ms` (#1012) tests below, which need to
 * separate two phases of one fetch: time to headers (before
 * `fetchWithTimeout`'s promise settles) vs. additional time inside
 * `response.json()` reading the body. Returns a REAL `Response` (via the
 * global constructor) with `.json` overridden to advance the fake-timer
 * clock before resolving — no type-assertion cast to `Response` needed,
 * since a real `Response` instance already satisfies the full type.
 * Requires `vi.useFakeTimers()` to be active in the caller: the delays below
 * are `vi.advanceTimersByTime` calls, not real waits.
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

function completion(overrides: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    model: 'openai/gpt-5.6-luna',
    usage: { prompt_tokens: 11, completion_tokens: 22 },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('nousChat', () => {
  it('posts to the chat-completions path with a bearer key', async () => {
    const fetchMock = stubFetch(completion());

    await nousChat(OPTIONS, REQUEST);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://nous.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-fake-nous-key',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'openai/gpt-5.6-luna',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('normalises OpenAI token counts into the shape the spend meter reads', async () => {
    stubFetch(completion());

    const result = await nousChat(OPTIONS, REQUEST);

    expect(result.text).toBe('{"ok":true}');
    // `cache_read_input_tokens` is present and zero rather than absent: a
    // response reporting no cache hit is a real zero, not an unknown.
    expect(result.usage).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 0,
    });
  });

  it('treats an absent usage block as zero rather than NaN', async () => {
    // A zero-token row is visibly free; a NaN would be written to `llm_spend`
    // and poison the cap's SUM.
    stubFetch(completion({ usage: undefined }));

    const result = await nousChat(OPTIONS, REQUEST);

    expect(result.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  describe('truncation', () => {
    /**
     * The money case. `finish_reason: 'length'` means the model ran out of
     * budget mid-answer, so the text is partial or empty. Left to reach
     * `parseResponse` it becomes `LlmMalformedResponseError`, which
     * `isRetryable` RETRIES — re-billing a failure that is deterministic at
     * the same `max_tokens`. `NousTruncatedError` carries no `.status`, so
     * `classifyProviderError` lands it on the non-retryable branch.
     */
    it('throws rather than returning partial text', async () => {
      stubFetch(
        completion({
          choices: [{ message: { content: '{"stan' }, finish_reason: 'length' }],
        }),
      );

      await expect(nousChat(OPTIONS, REQUEST)).rejects.toThrow(NousTruncatedError);
    });

    it('throws even when the truncated body carries no content at all', async () => {
      // The kimi-k3 shape recorded in ai-review.yml: the whole budget spent on
      // hidden reasoning tokens, zero answer text, every time.
      stubFetch(
        completion({
          choices: [{ message: {}, finish_reason: 'length' }],
          usage: { prompt_tokens: 100, completion_tokens: 8192 },
        }),
      );

      await expect(nousChat(OPTIONS, REQUEST)).rejects.toThrow(/finish_reason="length"/);
    });

    it('carries no status, so the error cannot be classified as retryable', async () => {
      stubFetch(completion({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }));

      const error = await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NousTruncatedError);
      expect((error as { status?: unknown }).status).toBeUndefined();
    });

    it('carries the billed token counts, which no meter will otherwise see', async () => {
      stubFetch(
        completion({
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 100, completion_tokens: 1024 },
        }),
      );

      const error = (await nousChat(OPTIONS, REQUEST).catch(
        (e: unknown) => e,
      )) as NousTruncatedError;
      expect(error.usage).toEqual({
        input_tokens: 100,
        output_tokens: 1024,
        cache_read_input_tokens: 0,
      });
    });
  });

  describe('metered model id', () => {
    it('meters against the echoed model when this system can price it', async () => {
      // A server-side reroute bills what ran, not what was asked for.
      stubFetch(completion({ model: 'anthropic/claude-haiku-4.5' }));

      const result = await nousChat(OPTIONS, REQUEST);

      expect(result.model).toBe('anthropic/claude-haiku-4.5');
    });

    /**
     * The second silent-money case. A proxy can echo an upstream vendor's own
     * id, which `MODEL_RATES` does not carry. Metering against it records a
     * null `cost_usd`; `spend-cap.ts` sums nulls as zero; the $50/14d ceiling
     * quietly stops existing. Falling back to the requested id — already
     * proved priceable by `nousCredentials` — keeps the row counted.
     */
    it('falls back to the requested id when the echo is not priceable', async () => {
      stubFetch(completion({ model: 'claude-haiku-4-5-20251001' }));

      const result = await nousChat(OPTIONS, REQUEST);

      expect(result.model).toBe('openai/gpt-5.6-luna');
    });

    it('falls back when the provider echoes no model at all', async () => {
      stubFetch(completion({ model: undefined }));

      const result = await nousChat(OPTIONS, REQUEST);

      expect(result.model).toBe('openai/gpt-5.6-luna');
    });
  });

  describe('time-to-first-byte (#1012)', () => {
    /**
     * #1012: `latency_ms` (measured around the whole call, one layer up in
     * `anthropic-client.ts`) cannot distinguish queue/generation time from
     * body-read time because it is a single span. `ttfb_ms` isolates the
     * `fetchWithTimeout` half — headers received, before `response.json()`
     * reads the body — using fake timers so the two spans are exact and
     * non-flaky, the same technique `anthropic-client.test.ts` uses for
     * `latency_ms` (#326).
     */
    it('measures only the time up to the response settling, not the body read', async () => {
      vi.useFakeTimers();
      try {
        stubFetchWithTiming(completion(), { headerDelayMs: 4_000, bodyDelayMs: 1_000 });

        const result = await nousChat(OPTIONS, REQUEST);

        expect(result.ttfb_ms).toBe(4_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a smaller ttfb_ms than the caller-measured total latency when the body read is slow', async () => {
      // Cross-checks against the OUTER timer the way a caller (`anthropic-client.ts`)
      // actually measures `latency_ms` — around the whole `nousChat` call.
      vi.useFakeTimers();
      try {
        stubFetchWithTiming(completion(), { headerDelayMs: 4_000, bodyDelayMs: 1_000 });

        const start = Date.now();
        const result = await nousChat(OPTIONS, REQUEST);
        const callerMeasuredLatencyMs = Date.now() - start;

        expect(callerMeasuredLatencyMs).toBe(5_000);
        expect(result.ttfb_ms).toBeLessThan(callerMeasuredLatencyMs);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a ttfb_ms equal to total latency when the body is read instantly (the common case for a small JSON reply)', async () => {
      stubFetch(completion());

      const result = await nousChat(OPTIONS, REQUEST);

      // stubFetch's `json()` resolves with no artificial delay, so with real
      // timers ttfb_ms should be a small, non-negative number well under any
      // flake-prone threshold, and never negative.
      expect(result.ttfb_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('cache accounting (#1010)', () => {
    /**
     * #1010: `llm_spend.cache_creation_input_tokens` /
     * `cache_read_input_tokens` are zero on every one of 383 sampled debate
     * calls. Measurement (prompt-caching.test.ts) found the debate model's
     * requests fall well short of the 4,096-token minimum Anthropic requires
     * before it caches anything, so nothing in this repo requests caching —
     * see the comment on `anthropic-client.ts`'s `renderMessageContent`.
     *
     * This test used to pin the SEPARATE, structural half of that same zero:
     * the parser read only `prompt_tokens`/`completion_tokens` and had no
     * field to carry a cache count through, so a cache hit upstream was
     * invisible. #969 CLOSED that half — the retrieval path gets large
     * prompts cached by the provider on its own initiative, whether or not
     * anything here asks for it, so an invisible cache line became a real
     * mispricing rather than a hypothetical one.
     *
     * What it pins now is the SUBTRACTION, which is the part that is easy to
     * get wrong in the expensive direction. Nous reports usage the OpenAI
     * way — `cached_tokens` is a SUBSET of `prompt_tokens` — while
     * `AnthropicUsage` means the Anthropic thing, where the two are disjoint
     * and `priceUsage` bills both. Carrying the count across without
     * subtracting bills the cached tokens twice.
     *
     * #1010's other finding is untouched and still true: nothing in this repo
     * REQUESTS caching, and the pinned debate model's requests fall short of
     * the minimum anyway — see `never sends a cache_control breakpoint` below,
     * which is now the canary for that half.
     *
     * The Anthropic-shaped `cache_read_input_tokens` guess is deliberately
     * still present in the fixture and deliberately still ignored: Nous is
     * OpenAI-shaped on both endpoints (verified on a live `/responses` probe,
     * 2026-09-03), and reading both would double-count a provider that sent
     * both spellings of the same number.
     */
    it('subtracts provider-reported cached tokens out of the input count', async () => {
      stubFetch(
        completion({
          usage: {
            prompt_tokens: 11,
            completion_tokens: 22,
            prompt_tokens_details: { cached_tokens: 9 },
            cache_read_input_tokens: 9,
            cache_creation_input_tokens: 2,
          },
        }),
      );

      const result = await nousChat(OPTIONS, REQUEST);

      // 11 prompt tokens of which 9 were cached = 2 fresh, not 11 fresh plus
      // 9 cached. The wrong reading over-counts this call by ~80%.
      expect(result.usage).toEqual({
        input_tokens: 2,
        output_tokens: 22,
        cache_read_input_tokens: 9,
      });
      // Cache WRITES stay dropped: nothing in this system writes a cache
      // entry, so a provider reporting one is not a case this meter has a
      // rate for (`CACHE_WRITE_MULTIPLIER` remains inert in pricing.ts).
      expect(result.usage).not.toHaveProperty('cache_creation_input_tokens');
    });

    it('never reports more cached tokens than the prompt contained', async () => {
      // Defensive against an inverted provider report. Without the clamp,
      // `input_tokens` goes negative, `priceUsage` returns a NEGATIVE cost,
      // and the row BUYS BACK headroom under ADR-0008's ceiling — a spend
      // meter that can be credited by a malformed response is not a ceiling.
      stubFetch(
        completion({
          usage: {
            prompt_tokens: 5,
            completion_tokens: 22,
            prompt_tokens_details: { cached_tokens: 9000 },
          },
        }),
      );

      const result = await nousChat(OPTIONS, REQUEST);

      expect(result.usage).toEqual({
        input_tokens: 0,
        output_tokens: 22,
        cache_read_input_tokens: 5,
      });
    });

    it('never sends a cache_control breakpoint in the POSTed request body', async () => {
      // Documents present-day behaviour: the request builder has no
      // content-block structure to attach `cache_control` to (flat string
      // `content`, see `NousChatMessage` above), so it can't appear by
      // construction. This is the canary for that changing silently — if a
      // future change starts sending one, it should be a deliberate,
      // measured decision (prompt-caching.test.ts re-cleared, Nous's
      // pass-through behaviour confirmed), not an accident.
      const fetchMock = stubFetch(completion());

      await nousChat(OPTIONS, REQUEST);

      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.body as string).not.toContain('cache_control');
    });
  });

  describe('failures', () => {
    it('exposes the HTTP status, which is what classifies a 429 as retryable', async () => {
      stubFetch({ error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429 });

      const error = (await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e)) as NousApiError;
      expect(error).toBeInstanceOf(NousApiError);
      expect(error.status).toBe(429);
      expect(error.message).toContain('rate_limit_error');
    });

    it('truncates an unbounded provider message before it reaches the log line', async () => {
      // Review round 1 (#1055). `error.message` is a provider-supplied string
      // of unbounded length, and this message goes to the log sink and to
      // alert transports. An upstream returning a megabyte of prose would
      // otherwise put a megabyte into EVERY retry's log line. The full body
      // stays available unmodified on `.body` for anyone who needs it.
      const huge = 'x'.repeat(20_000);
      stubFetch({ error: { type: 'server_error', message: huge } }, { status: 500 });

      const error = (await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e)) as NousApiError;

      expect(error.message.length).toBeLessThan(2_000);
      expect(error.message).toContain('truncated');
      expect(error.message).toContain('server_error');
      expect(JSON.stringify(error.body)).toContain(huge);
    });

    it('never puts the API key in an error message', async () => {
      // Error strings go straight to logs, and a provider echoing the request
      // back is exactly how a key ends up in one.
      stubFetch({ error: { type: 'invalid_request', message: 'bad' } }, { status: 400 });

      const error = (await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e)) as Error;
      expect(error.message).not.toContain('test-fake-nous-key');
    });

    it('wraps an unparseable 2xx body instead of leaking a raw SyntaxError', async () => {
      stubFetch(
        {},
        {
          jsonOverride: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        },
      );

      await expect(nousChat(OPTIONS, REQUEST)).rejects.toThrow(NousApiError);
    });

    it('rejects a 2xx with no choices rather than reporting empty text', async () => {
      // Empty text would parse as a malformed response and be retried; a
      // structurally wrong body is not a transient sample.
      stubFetch(completion({ choices: [] }));

      await expect(nousChat(OPTIONS, REQUEST)).rejects.toThrow(/choices/);
    });
  });
});
