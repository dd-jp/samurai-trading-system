import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmInFlightGate } from './in-flight-gate.js';
import { UNGATED_LLM_IN_FLIGHT } from './in-flight-gate.js';
import { nousResponses } from './nous-responses.js';

const OPTIONS = {
  apiKey: 'test-fake-nous-key',
  baseUrl: 'https://nous.test/v1',
  gate: UNGATED_LLM_IN_FLIGHT,
};
const REQUEST = {
  model: 'x-ai/grok-4.5',
  input: 'What is the latest sentiment?',
  max_output_tokens: 1024,
};

function responseBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'x-ai/grok-4.5',
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
    usage: { prompt_tokens: 11, completion_tokens: 22 },
    ...overrides,
  };
}

function stubFetch(body: unknown, init: { status?: number } = {}) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify(body), { status: init.status ?? 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('nousResponses', () => {
  it('posts to the responses path with a bearer key and extracts the message text', async () => {
    const fetchMock = stubFetch(responseBody());

    const result = await nousResponses(OPTIONS, REQUEST);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://nous.test/v1/responses');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-fake-nous-key',
    );
    expect(result.text).toBe('hello');
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
        'push wall clock past gateBudgetMs (AC2 — held-permit test, retrieval path)',
      async () => {
        vi.useFakeTimers();
        try {
          const hanging = stubHangingFetch();

          const resultPromise = nousResponses(
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

    it('does not clamp when clampCallToBudget is left unset', async () => {
      vi.useFakeTimers();
      try {
        const hanging = stubHangingFetch();

        const resultPromise = nousResponses(
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
  });
});
