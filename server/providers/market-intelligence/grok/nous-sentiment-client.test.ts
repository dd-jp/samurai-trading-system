/**
 * `NousSentimentClient` — the first unit test this wire client has ever had.
 * `XaiGrokClient`, which it replaces, was the only wire client in the repo
 * without one; its parse-salvage and field-validation paths were exercised
 * only indirectly, through a fake in `grok-agent.test.ts`.
 *
 * Both paths are load-bearing. The salvage decides whether a fenced answer
 * counts as data or as an outage, and the validation is the only thing between
 * a model inventing `sentiment: 2` and that value reaching the analysts'
 * arithmetic as a direction the type system says cannot exist.
 */
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
    // `cache_read_input_tokens` present and zero: `nousChat` now reports the
    // cache line rather than dropping it (#969), and no cache hit is a real
    // zero rather than an unknown
    expect(result.usage).toEqual({
      input_tokens: 40,
      output_tokens: 60,
      cache_read_input_tokens: 0,
    });
  });

  it('reports an empty list as zero items, not as a failure', async () => {
    // "Nothing is being said about this" is a real answer, and the prompt asks
    // for it explicitly rather than letting the model invent filler
    stubContent('{"items":[]}');

    const result = await client().fetchSentiment('BTC-USD', AS_OF);

    expect(result.items).toEqual([]);
  });

  describe('salvage', () => {
    it('recovers an answer wrapped in a markdown fence', async () => {
      // The failure that broke the debate path on the previously pinned model
      // (#361): the JSON is correct, the fence is not
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
      // Zero reaches the analysts as NO_DATA_MARKER — the same degradation as
      // an outage, which is correct: an answer we cannot read is not an answer
      // The warn is what stops it looking free; the call was still billed
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
      // Partial rejection, not all-or-nothing: one bad row must not discard
      // the signal that came back with it
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
    // GrokAgent's fail-closed guard trusts this flag to decide whether to
    // ingest. If this client ever answered `true` here, it would be lying
    // about what `chat/completions` structurally cannot provide — no
    // citations, no tool step — and un-retrieved recall would reach the
    // analysts as signal again
    stubContent(ONE_ITEM);

    const result = await client().fetchSentiment('BTC-USD', AS_OF);

    expect(result.items).toHaveLength(1); // still parsed — GrokAgent decides what happens next
    expect(result.retrievalEvidence).toBe(false);
  });

  it('propagates a provider failure rather than reporting a silent zero', async () => {
    // `GrokAgent.refresh` catches this and marks no bucket, so a transient
    // outage does not buy four hours of silence. Swallowing it here would.
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
    // The opposite of the transient above, and deliberately so. `GrokAgent`
    // meters and marks the bucket on a RETURN; a throw skips both, so a
    // refusal thrown from here would go unmetered and re-issue the identical
    // prompt every tick until the bucket rolled
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
