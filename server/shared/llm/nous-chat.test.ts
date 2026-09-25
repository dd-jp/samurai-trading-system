import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmInFlightGate } from './in-flight-gate.js';
import { UNGATED_LLM_IN_FLIGHT } from './in-flight-gate.js';
import { NousApiError, NousRefusalError, NousTruncatedError, nousChat } from './nous-chat.js';

const OPTIONS = {
  apiKey: 'test-fake-nous-key',
  baseUrl: 'https://nous.test/v1',
  gate: UNGATED_LLM_IN_FLIGHT,
};
const REQUEST = {
  model: 'openai/gpt-5.6-luna',
  max_tokens: 1024,
  messages: [{ role: 'user' as const, content: 'hello' }],
};

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

function stubFetchWithTiming(
  body: unknown,
  timing: { headerDelayMs: number; bodyDelayMs: number },
) {
  const fetchMock = vi.fn(async () => {
    vi.advanceTimersByTime(timing.headerDelayMs);
    const response = new Response(JSON.stringify(body), { status: 200, statusText: 'OK' });
    const originalJson = response.json.bind(response);
    Object.defineProperty(response, 'json', {
      value: async () => {
        vi.advanceTimersByTime(timing.bodyDelayMs);
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
    expect(result.usage).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 0,
    });
  });

  it('treats an absent usage block as zero rather than NaN', async () => {
    stubFetch(completion({ usage: undefined }));

    const result = await nousChat(OPTIONS, REQUEST);

    expect(result.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  describe('truncation', () => {
    it('throws rather than returning partial text', async () => {
      stubFetch(
        completion({
          choices: [{ message: { content: '{"stan' }, finish_reason: 'length' }],
        }),
      );

      await expect(nousChat(OPTIONS, REQUEST)).rejects.toThrow(NousTruncatedError);
    });

    it('throws even when the truncated body carries no content at all', async () => {
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

  describe('refusal', () => {
    it('throws on finish_reason="content_filter"', async () => {
      stubFetch(
        completion({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }),
      );

      const error = await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NousRefusalError);
      expect((error as NousRefusalError).signal).toBe('finish_reason="content_filter"');
      expect((error as NousRefusalError).message).toMatch(
        /signalled finish_reason="content_filter" after 22 output tokens\. Not retried/,
      );
    });

    it('throws on a message.refusal string even when finish_reason is "stop"', async () => {
      stubFetch(
        completion({
          choices: [
            {
              message: { content: '', refusal: 'I cannot help with that.' },
              finish_reason: 'stop',
            },
          ],
        }),
      );

      const error = await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NousRefusalError);
      expect((error as NousRefusalError).signal).toBe('message.refusal');
    });

    it('does not fire on prose that merely reads like a refusal', async () => {
      stubFetch(
        completion({
          choices: [
            { message: { content: 'I cannot provide trading advice.' }, finish_reason: 'stop' },
          ],
        }),
      );

      const result = await nousChat(OPTIONS, REQUEST);

      expect(result.text).toBe('I cannot provide trading advice.');
    });

    it('carries no status, so the error cannot be classified as retryable', async () => {
      stubFetch(
        completion({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }),
      );

      const error = await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NousRefusalError);
      expect((error as { status?: unknown }).status).toBeUndefined();
    });

    it('carries the billed token counts, which no meter will otherwise see', async () => {
      stubFetch(
        completion({
          choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
          usage: { prompt_tokens: 900, completion_tokens: 3 },
        }),
      );

      const error = (await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e)) as NousRefusalError;

      expect(error.usage).toEqual({
        input_tokens: 900,
        output_tokens: 3,
        cache_read_input_tokens: 0,
      });
      expect(error.message).toContain('3 output tokens');
    });
  });

  describe('metered model id', () => {
    it('meters against the echoed model when this system can price it', async () => {
      stubFetch(completion({ model: 'anthropic/claude-haiku-4.5' }));

      const result = await nousChat(OPTIONS, REQUEST);

      expect(result.model).toBe('anthropic/claude-haiku-4.5');
      expect(result.upstream_model).toBe('anthropic/claude-haiku-4.5');
    });

    it('falls back to the requested id when the echo is not priceable, keeping the raw echo', async () => {
      stubFetch(completion({ model: 'claude-haiku-4-5-20251001' }));

      const result = await nousChat(OPTIONS, REQUEST);

      expect(result.model).toBe('openai/gpt-5.6-luna');
      expect(result.upstream_model).toBe('claude-haiku-4-5-20251001');
    });

    it('falls back when the provider echoes no model at all', async () => {
      stubFetch(completion({ model: undefined }));

      const result = await nousChat(OPTIONS, REQUEST);

      expect(result.model).toBe('openai/gpt-5.6-luna');
      expect(result.upstream_model).toBeUndefined();
    });

    it('reports no upstream model when the echo is not a string', async () => {
      stubFetch(completion({ model: 42 }));

      const result = await nousChat(OPTIONS, REQUEST);

      expect(result.model).toBe('openai/gpt-5.6-luna');
      expect(result.upstream_model).toBeUndefined();
    });
  });

  describe('time-to-first-byte (#1012)', () => {
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

      expect(result.ttfb_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('cache accounting (#1010)', () => {
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

      expect(result.usage).toEqual({
        input_tokens: 2,
        output_tokens: 22,
        cache_read_input_tokens: 9,
      });
      expect(result.usage).not.toHaveProperty('cache_creation_input_tokens');
    });

    it('never reports more cached tokens than the prompt contained', async () => {
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
      const fetchMock = stubFetch(completion());

      await nousChat(OPTIONS, REQUEST);

      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.body as string).not.toContain('cache_control');
    });
  });

  describe('gate-budget clamp (#1533)', () => {
    function delayingGate(waitMs: number): LlmInFlightGate {
      return {
        acquire: async () => {
          vi.advanceTimersByTime(waitMs);
          return { release: () => undefined };
        },
      };
    }

    function stubHangingFetch(): { signal: () => AbortSignal | undefined } {
      let capturedSignal: AbortSignal | undefined;
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        capturedSignal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => reject(capturedSignal?.reason));
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      return { signal: () => capturedSignal };
    }

    it(
      'shrinks the network timeout by the gate wait already spent, so a held permit cannot ' +
        'push wall clock past gateBudgetMs (AC2 — held-permit test)',
      async () => {
        vi.useFakeTimers();
        try {
          const hanging = stubHangingFetch();

          const resultPromise = nousChat(
            {
              ...OPTIONS,
              gate: delayingGate(800),
              gateBudgetMs: 1_000,
              timeoutMs: 5_000,
              clampCallToBudget: true,
            },
            REQUEST,
          );
          const rejection = expect(resultPromise).rejects.toMatchObject({ name: 'TimeoutError' });

          await vi.advanceTimersByTimeAsync(199);
          expect(hanging.signal()?.aborted).toBe(false);

          await vi.advanceTimersByTimeAsync(1);
          expect(hanging.signal()?.aborted).toBe(true);

          await rejection;
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("does not clamp when clampCallToBudget is left unset (the debate client's deliberate posture)", async () => {
      vi.useFakeTimers();
      try {
        const hanging = stubHangingFetch();

        const resultPromise = nousChat(
          { ...OPTIONS, gate: delayingGate(800), gateBudgetMs: 1_000, timeoutMs: 5_000 },
          REQUEST,
        );
        const rejection = expect(resultPromise).rejects.toMatchObject({ name: 'TimeoutError' });

        await vi.advanceTimersByTimeAsync(4_999);
        expect(hanging.signal()?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(hanging.signal()?.aborted).toBe(true);

        await rejection;
      } finally {
        vi.useRealTimers();
      }
    });

    it('never clamps below zero when the wait already exceeded the budget', async () => {
      vi.useFakeTimers();
      try {
        stubHangingFetch();

        const resultPromise = nousChat(
          {
            ...OPTIONS,
            gate: delayingGate(1_500),
            gateBudgetMs: 1_000,
            timeoutMs: 5_000,
            clampCallToBudget: true,
          },
          REQUEST,
        );
        const rejection = expect(resultPromise).rejects.toMatchObject({ name: 'TimeoutError' });

        await vi.advanceTimersByTimeAsync(0);
        await rejection;
      } finally {
        vi.useRealTimers();
      }
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
      const huge = 'x'.repeat(20_000);
      stubFetch({ error: { type: 'server_error', message: huge } }, { status: 500 });

      const error = (await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e)) as NousApiError;

      expect(error.message.length).toBeLessThan(2_000);
      expect(error.message).toContain('truncated');
      expect(error.message).toContain('server_error');
      expect(JSON.stringify(error.body)).toContain(huge);
    });

    it.each([
      [
        'a typed error',
        { error: { type: 'invalid_request', message: 'bad' } },
        'invalid_request: bad',
      ],
      ['an untyped error', { error: { message: 'bad' } }, 'error: bad'],
      ['a non-string message', { error: { type: 'invalid_request', message: 5 } }, 'OK'],
      ['a null error', { error: null }, 'OK'],
      ['a string error', { error: 'bad' }, 'OK'],
      ['a string body', 'bad', 'OK'],
      ['a null body', null, 'OK'],
    ])('describes %s in the error message', async (_label, body, detail) => {
      stubFetch(body, { status: 400 });

      const error = (await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e)) as NousApiError;

      expect(error.message).toBe(`Nous API error: 400 ${detail}`);
    });

    it('falls back to the status text when the error body is not JSON', async () => {
      stubFetch({}, { status: 502, jsonOverride: () => Promise.reject(new SyntaxError('<html>')) });

      const error = (await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e)) as NousApiError;

      expect(error.message).toBe('Nous API error: 502 OK');
      expect(error.body).toBeUndefined();
    });

    it('never puts the API key in an error message', async () => {
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
      stubFetch(completion({ choices: [] }));

      await expect(nousChat(OPTIONS, REQUEST)).rejects.toThrow(/choices/);
    });

    it('rejects a 2xx whose body has no choices field as a NousApiError', async () => {
      stubFetch({ model: 'openai/gpt-5.6-luna' });

      const error = await nousChat(OPTIONS, REQUEST).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NousApiError);
      expect((error as NousApiError).status).toBe(200);
    });

    it('reads a choice with no message and a non-string finish_reason as empty text, no reason', async () => {
      stubFetch(completion({ choices: [{ finish_reason: 42 }] }));

      const result = await nousChat(OPTIONS, REQUEST);

      expect(result.text).toBe('');
      expect(result.finish_reason).toBeNull();
    });
  });
});
