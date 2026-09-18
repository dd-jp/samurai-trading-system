import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNGATED_LLM_IN_FLIGHT } from '../../../shared/llm/index.js';
import type { LogEntry, Logger } from '../../../shared/types.js';
import { NousSentimentClient } from './nous-sentiment-client.js';

const AS_OF = new Date('2026-08-06T12:00:00.000Z');

function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

function stubContent(content: string, overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [{ message: { content }, finish_reason: 'stop' }],
          model: '~x-ai/grok-latest',
          usage: { prompt_tokens: 40, completion_tokens: 60 },
          ...overrides,
        }),
      }) as Response,
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function client(logger?: Logger) {
  return new NousSentimentClient({
    apiKey: 'test-fake-nous-key',
    baseUrl: 'https://nous.test/v1',
    model: '~x-ai/grok-latest',
    gate: UNGATED_LLM_IN_FLIGHT,
    ...(logger === undefined ? {} : { logger }),
  });
}

const ONE_ITEM = JSON.stringify({
  items: [
    { headline: 'ETF inflows accelerating', sentiment: 1, confidence: 0.7, summary: 'steady bid' },
  ],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NousSentimentClient', () => {
  it('normalises a clean JSON answer into intelligence items', async () => {
    stubContent(ONE_ITEM);

    const result = await client().fetchSentiment('BTC-USD', AS_OF);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      source: 'twitter',
      type: 'sentiment',
      entity: 'BTC-USD',
      headline: 'ETF inflows accelerating',
      sentiment: 1,
      confidence: 0.7,
    });
    expect(result.usage).toEqual({
      input_tokens: 40,
      output_tokens: 60,
      cache_read_input_tokens: 0,
    });
  });

  it('reports an empty list as zero items, not as a failure', async () => {
    stubContent('{"items":[]}');

    const result = await client().fetchSentiment('BTC-USD', AS_OF);

    expect(result.items).toEqual([]);
  });

  describe('salvage', () => {
    it('recovers an answer wrapped in a markdown fence', async () => {
      stubContent(`\`\`\`json\n${ONE_ITEM}\n\`\`\``);

      const result = await client().fetchSentiment('BTC-USD', AS_OF);

      expect(result.items).toHaveLength(1);
    });

    it('recovers an answer buried in prose', async () => {
      stubContent(`Here is what I found:\n${ONE_ITEM}\nHope that helps.`);

      const result = await client().fetchSentiment('BTC-USD', AS_OF);

      expect(result.items).toHaveLength(1);
    });

    it('reports zero items and warns when nothing can be salvaged', async () => {
      const logger = recordingLogger();
      stubContent('I am unable to help with that request.');

      const result = await client(logger).fetchSentiment('BTC-USD', AS_OF);

      expect(result.items).toEqual([]);
      expect(logger.entries[0]?.level).toBe('warn');
      expect(logger.entries[0]?.message).toContain('cost money and produced nothing');
    });

    it('reports zero items when the payload is JSON but has no items array', async () => {
      const logger = recordingLogger();
      stubContent('{"sentiment":"bullish"}');

      const result = await client(logger).fetchSentiment('BTC-USD', AS_OF);

      expect(result.items).toEqual([]);
      expect(logger.entries).toHaveLength(1);
    });
  });

  describe('field validation', () => {
    it('drops an item whose sentiment is outside 1 | 0 | -1', async () => {
      stubContent(JSON.stringify({ items: [{ headline: 'h', sentiment: 2, confidence: 0.5 }] }));

      const result = await client().fetchSentiment('BTC-USD', AS_OF);

      expect(result.items).toEqual([]);
    });

    it('clamps a confidence above 1 rather than letting it skew the arithmetic', async () => {
      stubContent(JSON.stringify({ items: [{ headline: 'h', sentiment: 1, confidence: 1.4 }] }));

      const result = await client().fetchSentiment('BTC-USD', AS_OF);

      expect(result.items[0]?.confidence).toBe(1);
    });

    it('drops an item with a blank headline', async () => {
      stubContent(JSON.stringify({ items: [{ headline: '  ', sentiment: 1, confidence: 0.5 }] }));

      const result = await client().fetchSentiment('BTC-USD', AS_OF);

      expect(result.items).toEqual([]);
    });

    it('keeps the valid items when only some are malformed', async () => {
      stubContent(
        JSON.stringify({
          items: [
            { headline: 'good', sentiment: -1, confidence: 0.4 },
            { headline: 'bad', sentiment: 7, confidence: 0.4 },
          ],
        }),
      );

      const result = await client().fetchSentiment('BTC-USD', AS_OF);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.headline).toBe('good');
    });

    it('caps the item count so a chatty answer is spend, not signal', async () => {
      stubContent(
        JSON.stringify({
          items: Array.from({ length: 25 }, (_, i) => ({
            headline: `theme ${i}`,
            sentiment: 0,
            confidence: 0.5,
          })),
        }),
      );

      const result = await client().fetchSentiment('BTC-USD', AS_OF);

      expect(result.items).toHaveLength(10);
    });
  });

  it('never claims retrieval evidence, because chat/completions cannot carry it (#485)', async () => {
    stubContent(ONE_ITEM);

    const result = await client().fetchSentiment('BTC-USD', AS_OF);

    expect(result.items).toHaveLength(1);
    expect(result.retrievalEvidence).toBe(false);
  });

  it('propagates a provider failure rather than reporting a silent zero', async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({}),
        }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().fetchSentiment('BTC-USD', AS_OF)).rejects.toThrow(/503/);
  });

  it('reports a refusal as zero items, carrying what the refused call billed (#1391)', async () => {
    const logger = recordingLogger();
    stubContent('', { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] });

    const result = await client(logger).fetchSentiment('BTC-USD', AS_OF);

    expect(result.items).toEqual([]);
    expect(result.usage).toEqual({
      input_tokens: 40,
      output_tokens: 60,
      cache_read_input_tokens: 0,
    });
    expect(logger.entries.map((entry) => entry.event)).toContain('sentiment_refused');
  });
});
