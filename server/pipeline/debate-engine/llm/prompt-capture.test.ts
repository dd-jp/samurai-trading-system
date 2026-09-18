import type {
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicMessagesClient,
} from './anthropic-client.js';
import { AnthropicLlmClient, renderMessageContent } from './anthropic-client.js';
import type { LlmSpendRecord } from './spend-sink.js';
import type { LlmRequest } from './types.js';

interface ParsedData {
  value: string;
}

const NO_RETRY = { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 };
const CONFIG = {
  model: 'openai/gpt-5.6-luna',
  max_tokens: 100,
  timeoutMs: 1_000,
  retry: NO_RETRY,
};

function request(): LlmRequest<ParsedData> {
  return {
    prompt: 'analyze this',
    context: { analyst_views: [{ stance: 'bullish' }] as unknown as [] },
    parseResponse: (rawText) =>
      rawText === 'good'
        ? { valid: true, data: { value: rawText } }
        : { valid: false, reason: 'not "good"' },
  };
}

function recordingSink(): { records: LlmSpendRecord[]; record: (e: LlmSpendRecord) => void } {
  const records: LlmSpendRecord[] = [];
  return { records, record: (entry) => records.push(entry) };
}

function usageResponse(text: string): AnthropicMessageResponse {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 120, output_tokens: 30 },
  };
}

describe('AnthropicLlmClient prompt capture', () => {
  it('captures the exact string that went on the wire', async () => {
    let sent: AnthropicMessageRequest | undefined;
    const wire: AnthropicMessagesClient = {
      createMessage: vi.fn(async (body: AnthropicMessageRequest) => {
        sent = body;
        return usageResponse('good');
      }),
    };
    const sink = recordingSink();

    await new AnthropicLlmClient(wire, CONFIG, sink).complete(request());

    const wireContent = sent?.messages[0]?.content;
    expect(sink.records[0]?.prompt).toBe(wireContent);
    expect(wireContent).toBe(renderMessageContent(request()));
  });

  it('captures the model response text', async () => {
    const wire: AnthropicMessagesClient = {
      createMessage: vi.fn().mockResolvedValue(usageResponse('good')),
    };
    const sink = recordingSink();

    await new AnthropicLlmClient(wire, CONFIG, sink).complete(request());

    expect(sink.records[0]?.response).toBe('good');
  });

  it('captures a MALFORMED response, which is when the text matters most', async () => {
    const wire: AnthropicMessagesClient = {
      createMessage: vi.fn().mockResolvedValue(usageResponse('not json at all')),
    };
    const sink = recordingSink();

    await expect(new AnthropicLlmClient(wire, CONFIG, sink).complete(request())).rejects.toThrow();

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.response).toBe('not json at all');
    expect(sink.records[0]?.prompt).toContain('analyze this');
  });

  it('still meters a billed call whose response has no content block', async () => {
    const wire: AnthropicMessagesClient = {
      createMessage: vi.fn().mockResolvedValue({ usage: { input_tokens: 120, output_tokens: 30 } }),
    };
    const sink = recordingSink();

    await expect(new AnthropicLlmClient(wire, CONFIG, sink).complete(request())).rejects.toThrow();

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.usage?.input_tokens).toBe(120);
  });

  it('captures nothing for an unmetered call', async () => {
    const wire: AnthropicMessagesClient = {
      createMessage: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'good' }] }),
    };
    const sink = recordingSink();

    await new AnthropicLlmClient(wire, CONFIG, sink).complete(request());

    expect(sink.records).toEqual([]);
  });

  it('captures nothing when the call itself throws', async () => {
    const wire: AnthropicMessagesClient = {
      createMessage: vi.fn().mockRejectedValue(new Error('upstream exploded')),
    };
    const sink = recordingSink();

    await expect(new AnthropicLlmClient(wire, CONFIG, sink).complete(request())).rejects.toThrow();

    expect(sink.records).toEqual([]);
  });

  it('does not fail the call when the sink throws while capturing', async () => {
    const wire: AnthropicMessagesClient = {
      createMessage: vi.fn().mockResolvedValue(usageResponse('good')),
    };
    const throwingSink = {
      record: () => {
        throw new Error('sink is broken');
      },
    };

    const result = await new AnthropicLlmClient(wire, CONFIG, throwingSink).complete(request());

    expect(result.data).toEqual({ value: 'good' });
  });
});
