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

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn(
    async () =>
      ({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        statusText: 'OK',
        json: async () => body,
      }) as Response,
  );
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
    expect(result.usage).toEqual({ input_tokens: 11, output_tokens: 22 });
  });

  it('treats an absent usage block as zero rather than NaN', async () => {
    // A zero-token row is visibly free; a NaN would be written to `llm_spend`
    // and poison the cap's SUM.
    stubFetch(completion({ usage: undefined }));

    const result = await nousChat(OPTIONS, REQUEST);

    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
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
      expect(error.usage).toEqual({ input_tokens: 100, output_tokens: 1024 });
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

  describe('cache accounting (#1010)', () => {
    /**
     * #1010: `llm_spend.cache_creation_input_tokens` /
     * `cache_read_input_tokens` are zero on every one of 383 sampled debate
     * calls. Measurement (prompt-caching.test.ts) found the debate model's
     * requests fall well short of the 4,096-token minimum Anthropic requires
     * before it caches anything, so nothing in this repo requests caching —
     * see the comment on `anthropic-client.ts`'s `renderMessageContent`.
     *
     * This test pins the SEPARATE, structural half of that same zero: even
     * if some future request DID clear the minimum and a provider/proxy
     * returned cache usage, this function only ever reads `prompt_tokens`
     * and `completion_tokens` off the response body and has no field to
     * carry a cache count through. A cache hit upstream would currently be
     * invisible here. If this test starts failing, it means someone widened
     * `usage` parsing without also widening `NousChatResult['usage']` and
     * `AnthropicUsage` (pricing.ts) to match — check both stay in sync before
     * "fixing" this assertion.
     *
     * The exact field name a caching-aware Nous response would use is
     * UNVERIFIED (Nous's own docs are not in this repo — see the deferral
     * note in pricing.ts) so this checks both an OpenAI-shaped
     * (`prompt_tokens_details.cached_tokens`) and an Anthropic-shaped
     * (`cache_read_input_tokens`) guess; either way, both are dropped today.
     */
    it('drops any cache-related usage fields a provider response might carry', async () => {
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

      expect(result.usage).toEqual({ input_tokens: 11, output_tokens: 22 });
      expect(result.usage).not.toHaveProperty('cache_read_input_tokens');
      expect(result.usage).not.toHaveProperty('cache_creation_input_tokens');
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
      stubFetch(
        { error: { type: 'rate_limit_error', message: 'slow down' } },
        {
          ok: false,
          status: 429,
        },
      );

      const error = (await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e)) as NousApiError;
      expect(error).toBeInstanceOf(NousApiError);
      expect(error.status).toBe(429);
      expect(error.message).toContain('rate_limit_error');
    });

    it('never puts the API key in an error message', async () => {
      // Error strings go straight to logs, and a provider echoing the request
      // back is exactly how a key ends up in one.
      stubFetch({ error: { type: 'invalid_request', message: 'bad' } }, { ok: false, status: 400 });

      const error = (await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e)) as Error;
      expect(error.message).not.toContain('test-fake-nous-key');
    });

    it('wraps an unparseable 2xx body instead of leaking a raw SyntaxError', async () => {
      const fetchMock = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => {
              throw new SyntaxError('Unexpected token <');
            },
          }) as unknown as Response,
      );
      vi.stubGlobal('fetch', fetchMock);

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
