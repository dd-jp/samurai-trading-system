import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../../../shared/index.js';
import {
  LlmInFlightRefusedError,
  NousAccountInFlightGate,
  UNGATED_LLM_IN_FLIGHT,
} from '../../../shared/llm/index.js';
import { AnthropicLlmClient } from './anthropic-client.js';
import {
  LlmAdmissionRefusedError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmTruncatedError,
} from './errors.js';
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
    expect((error as LlmTruncatedError).max_tokens).toBe(1024);
    expect((error as LlmTruncatedError).usage).toEqual({
      input_tokens: 10,
      output_tokens: 1024,
      cache_read_input_tokens: 0,
    });
    expect(classifyFailureCause(error)).toBe('truncated');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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
    expect((error as LlmRefusalError).usage).toEqual({
      input_tokens: 900,
      output_tokens: 3,
      cache_read_input_tokens: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a genuinely malformed sample, which a fresh draw can fix', async () => {
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

    const refused = await llm.complete(request()).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(LlmAdmissionRefusedError);
    expect(classifyFailureCause(refused)).toBe('gate_refused');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    for (let drained = 0; drained < admitted.length; drained += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(drained));
      releases[drained]?.();
    }
    await Promise.all(admitted);
  });

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
      await vi.advanceTimersByTimeAsync(22_200);

      const refused = await queued;
      expect(refused).toBeInstanceOf(LlmAdmissionRefusedError);
      expect((refused as LlmAdmissionRefusedError).reason).toBe('queue_deadline');
      expect(classifyFailureCause(refused)).toBe('gate_refused');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_800);
      expect(classifyFailureCause(await first)).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the request's true stage on the gate's llm_gate_refused log line, not the debate default", async () => {
    const entries: LogEntry[] = [];
    const gate = new NousAccountInFlightGate({
      maxInFlight: 1,
      expectedCallMs: 5_800,
      logger: { log: (entry) => entries.push(entry) },
    });
    const { fetchMock, releases } = gatedFetch();
    const llm = gatedClient(gate, 28_000);

    function criticRequest(): LlmRequest<{ stance: string }> {
      return {
        ...request(),
        context: {
          analyst_views: [],
          attribution: { trace_id: 'trace-1', debate_id: 'debate-1', stage: 'risk_critic' },
        },
      };
    }

    const admitted = [
      llm.complete(criticRequest()),
      llm.complete(criticRequest()),
      llm.complete(criticRequest()),
      llm.complete(criticRequest()),
    ];
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const refused = await llm.complete(criticRequest()).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LlmAdmissionRefusedError);

    const refusalLog = entries.find((entry) => entry.event === 'llm_gate_refused');
    expect(refusalLog?.payload).toMatchObject({ llm_stage: 'risk_critic' });

    for (let drained = 0; drained < admitted.length; drained += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(drained));
      releases[drained]?.();
    }
    await Promise.all(admitted);
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

    const after = await gate.acquire({ budgetMs: 28_000 });
    after.release();
    expect(LlmInFlightRefusedError.name).toBe('LlmInFlightRefusedError');
  });
});

describe('a Nous 429 carries its retry-after hint to LlmRateLimitError', () => {
  const RETRY_DATE = 'Wed, 21 Oct 2026 07:28:00 GMT';

  function rateLimited(headers: Record<string, string>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { type: 'rate_limit', message: 'slow down' } }), {
            status: 429,
            statusText: 'Too Many Requests',
            headers,
          }),
      ),
    );
    const client = new AnthropicLlmClient(new NousMessagesClient(OPTIONS), {
      model: 'openai/gpt-5.6-luna',
      max_tokens: 1024,
      timeoutMs: 5_000,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    return client.complete(request()).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it.each([
    ['delta seconds', { 'retry-after': '7' }, 7_000],
    ['an HTTP date 12s ahead', { 'retry-after': RETRY_DATE }, 12_000],
    ['an HTTP date already past', { 'retry-after': 'Wed, 21 Oct 2026 07:27:00 GMT' }, 0],
    ['no header', {}, undefined],
    ['a negative number', { 'retry-after': '-5' }, undefined],
    ['an unparseable word', { 'retry-after': 'soon' }, undefined],
  ])('%s', async (_label, headers, expected) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(RETRY_DATE) - 12_000);
    try {
      const error = await rateLimited(headers);
      expect(error).toBeInstanceOf(LlmRateLimitError);
      expect((error as LlmRateLimitError).retryAfterMs).toBe(expected);
      expect((error as LlmRateLimitError).message).toBe(
        'Nous API error: 429 rate_limit: slow down',
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('waits out the hint before retrying', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '2' } }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"stance":"bullish"}' }, finish_reason: 'stop' }],
            }),
            { status: 200 },
          ),
        );
      vi.stubGlobal('fetch', fetchMock);
      const client = new AnthropicLlmClient(new NousMessagesClient(OPTIONS), {
        model: 'openai/gpt-5.6-luna',
        max_tokens: 1024,
        timeoutMs: 60_000,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10_000 },
      });
      const pending = client.complete(request());
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ data: { stance: 'bullish' } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
