import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnthropicMessageResponse, AnthropicMessagesClient } from './anthropic-client.js';
import { AnthropicLlmClient } from './anthropic-client.js';
import {
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmTimeoutError,
} from './errors.js';
import type { LlmRequest } from './types.js';

interface ParsedData {
  value: string;
}

function textResponse(text: string): AnthropicMessageResponse {
  return { content: [{ type: 'text', text }] };
}

function request(parseResponse?: LlmRequest<ParsedData>['parseResponse']): LlmRequest<ParsedData> {
  return {
    prompt: 'analyze this',
    context: { analyst_views: [] },
    parseResponse:
      parseResponse ??
      ((rawText) =>
        rawText === 'good'
          ? { valid: true, data: { value: rawText } }
          : { valid: false, reason: 'not "good"' }),
  };
}

const NO_RETRY = { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 };

describe('AnthropicLlmClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the injected client and returns the parsed structured response', async () => {
    const wire: AnthropicMessagesClient = {
      createMessage: vi.fn().mockResolvedValue(textResponse('good')),
    };
    const client = new AnthropicLlmClient(wire, {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      timeoutMs: 1_000,
      retry: NO_RETRY,
    });

    const result = await client.complete(request());

    expect(result.data).toEqual({ value: 'good' });
    expect(result.raw_text).toBe('good');
    expect(wire.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-5', max_tokens: 1024 }),
    );
  });

  it('sends the prompt and context in the message content', async () => {
    const wire: AnthropicMessagesClient = {
      createMessage: vi.fn().mockResolvedValue(textResponse('good')),
    };
    const client = new AnthropicLlmClient(wire, {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      timeoutMs: 1_000,
      retry: NO_RETRY,
    });

    await client.complete(request());

    const sent = (wire.createMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.messages[0].content).toContain('analyze this');
    expect(sent.messages[0].content).toContain('analyst_views');
  });

  it('raises LlmMalformedResponseError when parseResponse rejects the output', async () => {
    const wire: AnthropicMessagesClient = {
      createMessage: vi.fn().mockResolvedValue(textResponse('garbage')),
    };
    const client = new AnthropicLlmClient(wire, {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      timeoutMs: 1_000,
      retry: NO_RETRY,
    });

    await expect(client.complete(request())).rejects.toBeInstanceOf(LlmMalformedResponseError);
  });

  it('raises LlmTimeoutError when the provider call exceeds timeoutMs', async () => {
    const wire: AnthropicMessagesClient = {
      createMessage: vi.fn().mockImplementation(() => new Promise(() => {})),
    };
    const client = new AnthropicLlmClient(wire, {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      timeoutMs: 500,
      retry: NO_RETRY,
    });

    const promise = client.complete(request());
    const assertion = expect(promise).rejects.toBeInstanceOf(LlmTimeoutError);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('classifies a 429 from the injected client as LlmRateLimitError', async () => {
    const wire: AnthropicMessagesClient = {
      createMessage: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 })),
    };
    const client = new AnthropicLlmClient(wire, {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      timeoutMs: 1_000,
      retry: NO_RETRY,
    });

    await expect(client.complete(request())).rejects.toBeInstanceOf(LlmRateLimitError);
  });

  it('classifies an unrecognized error as LlmProviderError', async () => {
    const wire: AnthropicMessagesClient = {
      createMessage: vi.fn().mockRejectedValue(new Error('server exploded')),
    };
    const client = new AnthropicLlmClient(wire, {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      timeoutMs: 1_000,
      retry: NO_RETRY,
    });

    await expect(client.complete(request())).rejects.toBeInstanceOf(LlmProviderError);
  });

  it('retries on rate limit and succeeds once the provider recovers', async () => {
    const wire: AnthropicMessagesClient = {
      createMessage: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
        .mockResolvedValueOnce(textResponse('good')),
    };
    const client = new AnthropicLlmClient(wire, {
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      timeoutMs: 1_000,
      retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1_000 },
    });

    const promise = client.complete(request());
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result.data).toEqual({ value: 'good' });
    expect(wire.createMessage).toHaveBeenCalledTimes(2);
  });
});
