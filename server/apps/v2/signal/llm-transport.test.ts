import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicLlmClient,
  classifyFailureCause,
  LlmProviderError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmTruncatedError,
  SqliteLlmSpendStore,
} from '../../../pipeline/debate-engine/index.js';
import type { LogEntry, Logger } from '../../../shared/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import { NousAccountInFlightGate, NousApiError } from '../../../shared/llm/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import { NousPinnedTransport } from './llm-transport.js';
import { DEEPSEEK_V4_PRO_PIN, JUDGE_PIN, type ModelPin, SONNET_5_PIN } from './models.js';
import { SqliteMonthlySpendCap } from './monthly-spend-cap.js';
import { ScriptedTransport } from './scripted-transport.js';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

function stubFetch(status: number, body: unknown, captured: Captured[] = []): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      captured.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body as string) as Record<string, unknown>,
        signal: init.signal,
      });
      return Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      );
    }),
  );
}

function completion(model: string, text: string, finish_reason = 'stop', refusal?: string) {
  return {
    model,
    choices: [{ message: { content: text, refusal }, finish_reason }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

const gate = () => new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: 10 });
const request = (model: string) => ({
  model,
  max_tokens: 64,
  messages: [{ role: 'user' as const, content: 'hello' }],
});
const transportFor = (pin: ModelPin, logger?: Logger, shared = gate()) =>
  new NousPinnedTransport({
    pin,
    apiKey: 'nous-secret',
    baseUrl: 'https://nous.test/v1',
    gate: shared,
    logger,
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NousPinnedTransport', () => {
  it('posts the Nous chat-completions shape with the bearer key and echoes the priced id', async () => {
    const captured: Captured[] = [];
    const logs: LogEntry[] = [];
    stubFetch(
      200,
      completion('anthropic/claude-sonnet-5', '{"stance":"bullish","rationale":"x"}'),
      captured,
    );
    const reply = await transportFor(SONNET_5_PIN, {
      log: (entry) => logs.push(entry),
    }).createMessage(request('anthropic/claude-sonnet-5'), { stage: 'debate' });
    expect(captured[0]?.url).toBe('https://nous.test/v1/chat/completions');
    expect(captured[0]?.headers.authorization).toBe('Bearer nous-secret');
    expect(captured[0]?.body).toEqual({
      model: 'anthropic/claude-sonnet-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(reply.model).toBe('anthropic/claude-sonnet-5');
    expect(reply.upstream_model).toBe('anthropic/claude-sonnet-5');
    expect(reply.content[0]?.text).toBe('{"stance":"bullish","rationale":"x"}');
    expect(reply.usage).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 });
    expect(typeof reply.ttfb_ms).toBe('number');
    expect(logs).toMatchObject([
      {
        trace_id: 'v2-llm',
        level: 'info',
        event: 'v2_llm_upstream_model',
        stage: 'debate',
        message: 'anthropic/claude-sonnet-5 answered as anthropic/claude-sonnet-5',
        payload: { pinned: 'anthropic/claude-sonnet-5', upstream: 'anthropic/claude-sonnet-5' },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain('nous-secret');
  });

  it('refuses a request for a model other than its pin before calling Nous', async () => {
    const captured: Captured[] = [];
    stubFetch(200, {}, captured);
    await expect(
      transportFor(SONNET_5_PIN).createMessage(request('anthropic/claude-fable-5')),
    ).rejects.toThrow(/transport for anthropic\/claude-sonnet-5 refused a request for model/);
    expect(captured).toHaveLength(0);
  });

  it('refuses a reply served by a model other than the pin and logs the swap', async () => {
    const logs: LogEntry[] = [];
    stubFetch(200, completion('anthropic/claude-opus-5.5-20260921', '{}'));
    const error = await transportFor(JUDGE_PIN, { log: (entry) => logs.push(entry) })
      .createMessage(request('anthropic/claude-opus-5.5'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmProviderError);
    expect((error as Error).message).toMatch(
      /Nous answered for anthropic\/claude-opus-5.5 with model anthropic\/claude-opus-5.5-20260921/,
    );
    expect(logs[0]?.payload).toEqual({
      pinned: 'anthropic/claude-opus-5.5',
      upstream: 'anthropic/claude-opus-5.5-20260921',
    });
  });

  it('bills a swapped-model reply to llm_spend under the priced id and the monthly cap counts it', async () => {
    const swapped = completion('anthropic/claude-opus-5.5-20260921', '{"stance":"bullish"}');
    swapped.usage = { prompt_tokens: 1_800_000, completion_tokens: 400_000 };
    stubFetch(200, swapped);
    const db = openSharedStore(':memory:');
    const clock = new SimulatedClock(new Date('2026-09-25T08:00:00.000Z'));
    const client = new AnthropicLlmClient(
      transportFor(JUDGE_PIN),
      {
        model: 'anthropic/claude-opus-5.5',
        max_tokens: 64,
        timeoutMs: 1_000,
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      },
      new SqliteLlmSpendStore(db),
    );
    try {
      await expect(
        client.complete({
          prompt: 'hello',
          context: { analyst_views: [] },
          parseResponse: (raw: string) => ({ valid: true as const, data: raw }),
        }),
      ).rejects.toBeInstanceOf(LlmProviderError);
      const rows = db
        .prepare('SELECT model, input_tokens, output_tokens, cost_usd FROM llm_spend')
        .all() as {
        model: string;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
      }[];
      expect(rows).toEqual([
        {
          model: 'anthropic/claude-opus-5.5',
          input_tokens: 1_800_000,
          output_tokens: 400_000,
          cost_usd: 1.8 * 4 + 0.4 * 20,
        },
      ]);
      const verdict = new SqliteMonthlySpendCap(db, clock, 15.2).check();
      expect(verdict).toMatchObject({ admitted: false, kind: 'budget', spent_usd: 15.2 });
    } finally {
      db.close();
    }
  });

  it('accepts a reply whose model field is missing and logs it as unreported', async () => {
    const logs: LogEntry[] = [];
    const { model: _dropped, ...unreported } = completion('x', 'ok');
    stubFetch(200, unreported);
    const reply = await transportFor(JUDGE_PIN, { log: (entry) => logs.push(entry) }).createMessage(
      request('anthropic/claude-opus-5.5'),
    );
    expect(reply.model).toBe('anthropic/claude-opus-5.5');
    expect(reply.upstream_model).toBeUndefined();
    expect(logs[0]?.message).toBe('anthropic/claude-opus-5.5 answered as unreported');
    expect(logs[0]?.stage).toBe('v2');
  });

  it('maps length, content_filter and message.refusal finishes to the typed errors', async () => {
    const wire = 'deepseek/deepseek-v4-pro-0813';
    stubFetch(200, completion(wire, '{"stan', 'length'));
    await expect(
      transportFor(DEEPSEEK_V4_PRO_PIN).createMessage(request(wire)),
    ).rejects.toBeInstanceOf(LlmTruncatedError);
    stubFetch(200, completion(wire, '', 'content_filter'));
    await expect(
      transportFor(DEEPSEEK_V4_PRO_PIN).createMessage(request(wire)),
    ).rejects.toBeInstanceOf(LlmRefusalError);
    stubFetch(200, completion(wire, '', 'stop', 'no'));
    await expect(
      transportFor(DEEPSEEK_V4_PRO_PIN).createMessage(request(wire)),
    ).rejects.toBeInstanceOf(LlmRefusalError);
  });

  it('surfaces a 429 as rate-limited and other statuses as transport failures without leaking the key', async () => {
    stubFetch(429, { error: { type: 'rate_limit', message: 'slow down' } });
    const limited = await transportFor(JUDGE_PIN)
      .createMessage(request('anthropic/claude-opus-5.5'))
      .catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(NousApiError);
    expect((limited as NousApiError).status).toBe(429);
    expect(classifyFailureCause(limited)).toBe('rate_limited');

    stubFetch(502, 'not json');
    const broken = await transportFor(JUDGE_PIN)
      .createMessage(request('anthropic/claude-opus-5.5'))
      .catch((e: unknown) => e);
    expect(broken).toBeInstanceOf(NousApiError);
    expect(classifyFailureCause(broken)).toBe('transport');
    expect((broken as Error).message).not.toContain('nous-secret');
  });

  it('is classified LlmRateLimitError by AnthropicLlmClient (maxAttempts: 1, so no retry runs here)', async () => {
    stubFetch(429, { error: { type: 'rate_limit', message: 'slow down' } });
    const client = new AnthropicLlmClient(transportFor(JUDGE_PIN), {
      model: 'anthropic/claude-opus-5.5',
      max_tokens: 64,
      timeoutMs: 1_000,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(
      client.complete({
        prompt: 'hello',
        context: { analyst_views: [] },
        parseResponse: (raw: string) => ({ valid: true as const, data: raw }),
      }),
    ).rejects.toBeInstanceOf(LlmRateLimitError);
  });

  it('passes the caller signal through to fetch', async () => {
    const captured: Captured[] = [];
    stubFetch(200, completion('anthropic/claude-opus-5.5', 'ok'), captured);
    const controller = new AbortController();
    await transportFor(JUDGE_PIN).createMessage(request('anthropic/claude-opus-5.5'), {
      signal: controller.signal,
    });
    expect(captured[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(captured[0]?.signal?.aborted).toBe(false);
    controller.abort();
    expect(captured[0]?.signal?.aborted).toBe(true);
  });

  it('releases the account gate slot after a failure', async () => {
    const shared = gate();
    stubFetch(500, {});
    await expect(
      transportFor(JUDGE_PIN, undefined, shared).createMessage(
        request('anthropic/claude-opus-5.5'),
      ),
    ).rejects.toThrow();
    const slot = await shared.acquire({ budgetMs: 1 });
    slot.release();
  });
});

describe('ScriptedTransport', () => {
  it('answers persona and mediator prompts with the script and records the call', async () => {
    const transport = new ScriptedTransport(JUDGE_PIN, (request) =>
      (request.messages[0]?.content ?? '').includes('Mediator persona')
        ? '{"stance":"neutral","rationale":"scripted","converged":true}'
        : '{"stance":"neutral","rationale":"scripted"}',
    );
    const mediator = await transport.createMessage(
      {
        ...request('anthropic/claude-opus-5.5'),
        messages: [{ role: 'user', content: 'Mediator persona' }],
      },
      { stage: 'debate' },
    );
    expect(JSON.parse(mediator.content[0]?.text ?? '')).toEqual({
      stance: 'neutral',
      rationale: 'scripted',
      converged: true,
    });
    const debater = await transport.createMessage(request('anthropic/claude-opus-5.5'));
    expect(JSON.parse(debater.content[0]?.text ?? '')).toEqual({
      stance: 'neutral',
      rationale: 'scripted',
    });
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.stage).toBe('debate');
    expect(mediator.model).toBe('anthropic/claude-opus-5.5');
  });
});
