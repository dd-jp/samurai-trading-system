import { describe, expect, it } from 'vitest';
import {
  LlmProviderError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmTruncatedError,
} from '../../pipeline/debate-engine/index.js';
import type { LogEntry, Logger } from '../../shared/index.js';
import { NousAccountInFlightGate } from '../../shared/llm/index.js';
import { AnthropicHttpTransport } from './anthropic-transport.js';
import type { FetchLike } from './llm-transport.js';
import { DEEPSEEK_V4_PRO_PIN, JUDGE_PIN, SONNET_5_PIN } from './models.js';
import { OpenRouterHttpTransport } from './openrouter-transport.js';
import { ScriptedTransport } from './scripted-transport.js';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(
  status: number,
  body: unknown,
  captured: Captured[],
  headers: Record<string, string> = {},
): FetchLike {
  return (url, init) => {
    captured.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    });
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }),
    );
  };
}

const gate = () => new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: 10 });
const request = (model: string) => ({
  model,
  max_tokens: 64,
  messages: [{ role: 'user' as const, content: 'hello' }],
});

describe('AnthropicHttpTransport', () => {
  it('posts the Messages API shape and echoes the priced id', async () => {
    const captured: Captured[] = [];
    const logs: LogEntry[] = [];
    const logger: Logger = { log: (entry) => logs.push(entry) };
    const transport = new AnthropicHttpTransport({
      apiKey: 'sk-secret',
      pin: SONNET_5_PIN,
      gate: gate(),
      logger,
      fetchImpl: fakeFetch(
        200,
        {
          model: 'claude-sonnet-5-20260601',
          content: [{ type: 'text', text: '{"stance":"bullish","rationale":"x"}' }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: 'end_turn',
        },
        captured,
      ),
    });
    const reply = await transport.createMessage(request('claude-sonnet-5'), { stage: 'debate' });
    expect(captured[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(captured[0]?.headers['x-api-key']).toBe('sk-secret');
    expect(captured[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(captured[0]?.body).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(reply.model).toBe('anthropic/claude-sonnet-5');
    expect(reply.content[0]?.text).toBe('{"stance":"bullish","rationale":"x"}');
    expect(reply.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(logs[0]?.event).toBe('v2_llm_upstream_model');
    expect(JSON.stringify(logs)).not.toContain('sk-secret');
  });

  it('refuses a request for a model other than its pin', async () => {
    const transport = new AnthropicHttpTransport({
      apiKey: 'k',
      pin: SONNET_5_PIN,
      gate: gate(),
      fetchImpl: fakeFetch(200, {}, []),
    });
    await expect(transport.createMessage(request('claude-fable-5-1'))).rejects.toBeInstanceOf(
      LlmProviderError,
    );
  });

  it('maps refusal and max_tokens stop reasons to typed errors', async () => {
    const make = (stop_reason: string) =>
      new AnthropicHttpTransport({
        apiKey: 'k',
        pin: JUDGE_PIN,
        gate: gate(),
        fetchImpl: fakeFetch(200, { content: [], usage: {}, stop_reason }, []),
      });
    await expect(make('refusal').createMessage(request('claude-opus-5'))).rejects.toBeInstanceOf(
      LlmRefusalError,
    );
    await expect(make('max_tokens').createMessage(request('claude-opus-5'))).rejects.toBeInstanceOf(
      LlmTruncatedError,
    );
  });

  it('maps 429 to a rate-limit error with retry-after and other statuses to provider errors', async () => {
    const limited = new AnthropicHttpTransport({
      apiKey: 'k',
      pin: JUDGE_PIN,
      gate: gate(),
      fetchImpl: fakeFetch(429, { error: 'slow down' }, [], { 'retry-after': '2' }),
    });
    const error = await limited.createMessage(request('claude-opus-5')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmRateLimitError);
    expect((error as LlmRateLimitError).retryAfterMs).toBe(2000);

    const broken = new AnthropicHttpTransport({
      apiKey: 'sk-secret',
      pin: JUDGE_PIN,
      gate: gate(),
      fetchImpl: fakeFetch(500, 'not json', []),
    });
    const providerError = await broken
      .createMessage(request('claude-opus-5'))
      .catch((e: unknown) => e);
    expect(providerError).toBeInstanceOf(LlmProviderError);
    expect((providerError as Error).message).not.toContain('sk-secret');
  });

  it('releases the gate slot after a failure', async () => {
    const shared = gate();
    const transport = new AnthropicHttpTransport({
      apiKey: 'k',
      pin: JUDGE_PIN,
      gate: shared,
      fetchImpl: fakeFetch(500, {}, []),
    });
    await expect(transport.createMessage(request('claude-opus-5'))).rejects.toThrow();
    const slot = await shared.acquire({ budgetMs: 1 });
    slot.release();
  });
});

describe('OpenRouterHttpTransport', () => {
  it('posts chat completions with pinned routing and decodes the OpenAI shape', async () => {
    const captured: Captured[] = [];
    const transport = new OpenRouterHttpTransport({
      apiKey: 'or-secret',
      pin: DEEPSEEK_V4_PRO_PIN,
      gate: gate(),
      fetchImpl: fakeFetch(
        200,
        {
          model: 'deepseek/deepseek-v4-pro-0813',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        },
        captured,
      ),
    });
    const reply = await transport.createMessage(request('deepseek/deepseek-v4-pro-0813'));
    expect(captured[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(captured[0]?.headers.authorization).toBe('Bearer or-secret');
    expect(captured[0]?.body.provider).toEqual({ allow_fallbacks: false, data_collection: 'deny' });
    expect(captured[0]?.body.model).toBe('deepseek/deepseek-v4-pro-0813');
    expect(reply.model).toBe('deepseek/deepseek-v4-pro');
    expect(reply.content[0]?.text).toBe('ok');
    expect(reply.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it('maps length and content_filter finishes', async () => {
    const make = (finish_reason: string, refusal?: string) =>
      new OpenRouterHttpTransport({
        apiKey: 'k',
        pin: DEEPSEEK_V4_PRO_PIN,
        gate: gate(),
        fetchImpl: fakeFetch(
          200,
          { choices: [{ message: { content: '', refusal }, finish_reason }] },
          [],
        ),
      });
    const wire = 'deepseek/deepseek-v4-pro-0813';
    await expect(make('length').createMessage(request(wire))).rejects.toBeInstanceOf(
      LlmTruncatedError,
    );
    await expect(make('content_filter').createMessage(request(wire))).rejects.toBeInstanceOf(
      LlmRefusalError,
    );
    await expect(make('stop', 'no').createMessage(request(wire))).rejects.toBeInstanceOf(
      LlmRefusalError,
    );
  });
});

describe('ScriptedTransport', () => {
  it('answers persona and mediator prompts with parseable JSON and records the call', async () => {
    const transport = new ScriptedTransport(JUDGE_PIN);
    const mediator = await transport.createMessage(
      { ...request('claude-opus-5'), messages: [{ role: 'user', content: 'Mediator persona' }] },
      { stage: 'debate' },
    );
    expect(JSON.parse(mediator.content[0]?.text ?? '')).toEqual({
      stance: 'neutral',
      rationale: 'scripted',
      converged: true,
    });
    const debater = await transport.createMessage(request('claude-opus-5'));
    expect(JSON.parse(debater.content[0]?.text ?? '')).toEqual({
      stance: 'neutral',
      rationale: 'scripted',
    });
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.stage).toBe('debate');
    expect(mediator.model).toBe('anthropic/claude-opus-5');
  });
});
