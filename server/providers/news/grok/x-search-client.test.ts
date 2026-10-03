import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LlmInFlightRefusedError,
  NousAccountInFlightGate,
  UNGATED_LLM_IN_FLIGHT,
} from '../../../shared/llm/index.js';
import type { LogEntry, Logger } from '../../../shared/types.js';
import { parseStatusUrl, XSearchClient } from './x-search-client.js';

const OPTIONS = {
  apiKey: 'test-fake-nous-key',
  baseUrl: 'https://nous.test/v1',
  windowMs: 2 * 60 * 60 * 1000,
  gate: UNGATED_LLM_IN_FLIGHT,
};

const AS_OF = new Date('2026-09-03T12:00:00Z');

function statusIdAt(at: Date): string {
  return String(((BigInt(at.getTime()) - 1_288_834_974_657n) << 22n) | 1n);
}

const FRESH_ID = statusIdAt(new Date(AS_OF.getTime() - 10 * 60_000));
const STALE_ID = statusIdAt(new Date(AS_OF.getTime() - 19 * 60 * 60_000));
const FRESH_URL = `https://x.com/trader_one/status/${FRESH_ID}`;
const STALE_URL = `https://x.com/trader_two/status/${STALE_ID}`;

function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

function responsesBody(
  options: { items?: unknown; citations?: string[]; createdAt?: number } = {},
) {
  const text = JSON.stringify({ items: options.items ?? [] });
  return {
    model: 'x-ai/grok-4.5',
    created_at: options.createdAt ?? Math.floor(AS_OF.getTime() / 1000),
    status: 'completed',
    usage: {
      prompt_tokens: 5_271,
      completion_tokens: 900,
      prompt_tokens_details: { cached_tokens: 0 },
    },
    citations: options.citations ?? [],
    output: [{ type: 'message', content: [{ type: 'output_text', text, annotations: [] }] }],
  };
}

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify(body), { status, statusText: 'OK' }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    url: FRESH_URL,
    headline: 'flows into the 3x long',
    sentiment: 1,
    confidence: 0.7,
    summary: 'buyers stepping in',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseStatusUrl', () => {
  it('decodes the post time from the snowflake id', () => {
    const at = new Date('2026-09-03T11:50:00.000Z');
    expect(parseStatusUrl(`https://x.com/someone/status/${statusIdAt(at)}`)?.postedAt).toEqual(at);
  });

  it('tolerates a tracking suffix, because a post is the same post with one', () => {
    expect(parseStatusUrl(`${FRESH_URL}?s=20`)?.statusId).toBe(FRESH_ID);
    expect(parseStatusUrl(`${FRESH_URL}#anchor`)?.handle).toBe('trader_one');
  });

  it('rejects a URL that is not an X status permalink', () => {
    expect(parseStatusUrl('https://timestampconvert.net/?t=123')).toBeNull();
    expect(parseStatusUrl('https://x.com/trader_one')).toBeNull();
    expect(parseStatusUrl('https://notx.com/trader_one/status/1234567890')).toBeNull();
  });

  it('does not round a status id through a float', () => {
    const id = '1962847362817364993';
    expect(parseStatusUrl(`https://x.com/a/status/${id}`)?.statusId).toBe(id);
  });
});

describe('XSearchClient', () => {
  it('requests the search tool with the configured result ceiling', async () => {
    const fetchMock = stubFetch(responsesBody());

    await new XSearchClient({ ...OPTIONS, maxSearchResults: 3 }).fetchSentiment('TSLA', AS_OF);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://nous.test/v1/responses');
    const body = JSON.parse(init.body as string) as {
      model: string;
      tools: { type: string; max_search_results: number; from_date: string; to_date: string }[];
    };
    expect(body.model).toBe('~x-ai/grok-latest');
    expect(body.tools[0]?.type).toBe('x_search');
    expect(body.tools[0]?.max_search_results).toBe(3);
    expect(body.tools[0]?.to_date).toBe('2026-09-03');
  });

  it('keeps an item whose permalink the response actually cited', async () => {
    stubFetch(responsesBody({ items: [item()], citations: [FRESH_URL] }));

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(`x:${FRESH_ID}`);
    expect(result.items[0]?.source).toBe('x');
    expect(result.items[0]?.url).toBe(FRESH_URL);
    expect(result.items[0]?.entity).toBe('TSLA');
    expect(result.items[0]?.timestamp).toEqual(new Date(AS_OF.getTime() - 10 * 60_000));
    expect(result.retrievalEvidence).toBe(true);
  });

  it('drops an item the response never cited, however well-formed', async () => {
    const invented = `https://x.com/ghost/status/${statusIdAt(new Date(AS_OF.getTime() - 60_000))}`;
    stubFetch(
      responsesBody({
        items: [item(), item({ url: invented, headline: 'recalled, not retrieved' })],
        citations: [FRESH_URL],
      }),
    );

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.items.map((entry) => entry.headline)).toEqual(['flows into the 3x long']);
  });

  it('takes the stored url from the citation, not from the model text', async () => {
    stubFetch(
      responsesBody({ items: [item({ url: `${FRESH_URL}?s=46` })], citations: [FRESH_URL] }),
    );

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.items[0]?.url).toBe(FRESH_URL);
  });

  it('drops a cited post that falls outside the bucket window', async () => {
    stubFetch(
      responsesBody({
        items: [item(), item({ url: STALE_URL, headline: 'yesterday' })],
        citations: [FRESH_URL, STALE_URL],
      }),
    );

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.items.map((entry) => entry.headline)).toEqual(['flows into the 3x long']);
  });

  it('rejects a citation that is not an X permalink', async () => {
    stubFetch(
      responsesBody({
        items: [item({ url: 'https://timestampconvert.net/?t=1' })],
        citations: ['https://timestampconvert.net/?t=1'],
      }),
    );

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.items).toEqual([]);
  });

  it('reports evidence for a call that looked and found nothing', async () => {
    stubFetch(responsesBody({ items: [], citations: [FRESH_URL] }));

    const result = await new XSearchClient(OPTIONS).fetchSentiment('QQQ', AS_OF);

    expect(result.items).toEqual([]);
    expect(result.retrievalEvidence).toBe(true);
  });

  it('reports NO evidence when the tool did not run', async () => {
    stubFetch(responsesBody({ items: [item()], citations: [] }));

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.retrievalEvidence).toBe(false);
  });

  it('counts server tool calls, capped at what the caller authorised', async () => {
    stubFetch(
      responsesBody({ citations: [FRESH_URL, STALE_URL, 'https://x.com/c/status/1234567890'] }),
    );

    const result = await new XSearchClient({ ...OPTIONS, maxSearchResults: 2 }).fetchSentiment(
      'TSLA',
      AS_OF,
    );

    expect(result.server_tool_calls).toBe(2);
  });

  it('bills what the provider REPORTS, even above the caller ceiling', async () => {
    stubFetch({
      ...responsesBody({ citations: [FRESH_URL] }),
      output: [
        { type: 'x_search_call' },
        { type: 'x_search_call' },
        { type: 'x_search_call' },
        {
          type: 'message',
          content: [{ type: 'output_text', text: '{"items":[]}', annotations: [] }],
        },
      ],
    });

    const result = await new XSearchClient({ ...OPTIONS, maxSearchResults: 1 }).fetchSentiment(
      'TSLA',
      AS_OF,
    );

    expect(result.server_tool_calls).toBe(3);
  });

  it('subtracts cached tokens out of the metered input count', async () => {
    stubFetch({
      ...responsesBody(),
      usage: {
        prompt_tokens: 58_153,
        completion_tokens: 4_007,
        prompt_tokens_details: { cached_tokens: 19_584 },
      },
    });

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.usage).toEqual({
      input_tokens: 38_569,
      output_tokens: 4_007,
      cache_read_input_tokens: 19_584,
    });
  });

  it('clamps an operator result count above the ceiling, loudly', async () => {
    const logger = recordingLogger();
    const fetchMock = stubFetch(responsesBody());

    await new XSearchClient({ ...OPTIONS, maxSearchResults: 100, logger }).fetchSentiment(
      'TSLA',
      AS_OF,
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      tools: { max_search_results: number }[];
    };
    expect(body.tools[0]?.max_search_results).toBe(10);
    expect(logger.entries.some((entry) => entry.message.includes('clamped to 10'))).toBe(true);
  });

  it('reports zero items rather than throwing on a body it cannot read', async () => {
    const logger = recordingLogger();
    stubFetch({
      ...responsesBody(),
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json at all' }] }],
    });

    const result = await new XSearchClient({ ...OPTIONS, logger }).fetchSentiment('TSLA', AS_OF);

    expect(result.items).toEqual([]);
    expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('reports zero rather than throwing when the body parses to a NON-OBJECT', async () => {
    for (const text of ['null', '5', '"just a string"']) {
      const logger = recordingLogger();
      stubFetch({
        ...responsesBody(),
        output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      });

      const result = await new XSearchClient({ ...OPTIONS, logger }).fetchSentiment('TSLA', AS_OF);

      expect(result.items).toEqual([]);
      expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
    }
  });

  it('logs each dropped-item count under its own key', async () => {
    const invented = `https://x.com/ghost/status/${statusIdAt(new Date(AS_OF.getTime() - 60_000))}`;
    stubFetch(
      responsesBody({
        items: [item(), item({ url: invented }), item({ url: STALE_URL }), null, 'not an object'],
        citations: [FRESH_URL, STALE_URL],
      }),
    );
    const logger = recordingLogger();

    await new XSearchClient({ ...OPTIONS, logger }).fetchSentiment('TSLA', AS_OF);

    const dropped = logger.entries.find((entry) => entry.event === 'x_search_items_dropped');
    expect(dropped?.payload).toEqual({
      instrument: 'TSLA',
      unevidenced: 1,
      stale: 1,
      unreadable_items: 2,
      kept: 1,
      citations: 2,
    });
  });

  it('drops a malformed ITEM without losing the well-formed ones beside it', async () => {
    stubFetch(
      responsesBody({
        items: [null, item({ url: FRESH_URL }), 'not an object', 42],
        citations: [FRESH_URL],
      }),
    );

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.items).toHaveLength(1);
  });

  it('bills a search that RAN and returned nothing, rather than zero', async () => {
    stubFetch({
      ...responsesBody({ citations: [] }),
      output: [
        { type: 'x_search_call' },
        { type: 'message', content: [{ type: 'output_text', text: '{"items":[]}' }] },
      ],
    });

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.items).toEqual([]);
    expect(result.server_tool_calls).toBe(1);
    expect(result.retrievalEvidence).toBe(false);
  });

  it('rejects a post that postdates the response citing it', async () => {
    const future = `https://x.com/a/status/${statusIdAt(new Date(AS_OF.getTime() + 60_000))}`;
    stubFetch(responsesBody({ items: [item({ url: future })], citations: [future] }));

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.items).toEqual([]);
  });

  it('validates every scored field before it becomes an item', async () => {
    stubFetch(
      responsesBody({
        items: [item({ sentiment: 5 }), item({ confidence: 'high' }), item({ headline: '' })],
        citations: [FRESH_URL],
      }),
    );

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.items).toEqual([]);
  });

  it('waits behind a held permit rather than refusing itself (#1080)', async () => {
    const gate = new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: 13_000 });
    const held = await gate.acquire({ budgetMs: 28_000 });
    const fetchMock = stubFetch(responsesBody());

    const pending = new XSearchClient({ ...OPTIONS, gate }).fetchSentiment('TSLA', AS_OF);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    held.release();
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('releases its permit when the call FAILS, not only when it succeeds (#1080)', async () => {
    const gate = new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: 13_000 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection reset');
      }),
    );

    await new XSearchClient({ ...OPTIONS, gate })
      .fetchSentiment('TSLA', AS_OF)
      .catch(() => undefined);

    const after = await gate.acquire({ budgetMs: 1_000 });
    after.release();
  });

  it('declares its MEASURED duration to the gate, not its timeout (#1080)', async () => {
    const entries: LogEntry[] = [];
    const gate = new NousAccountInFlightGate({
      maxInFlight: 1,
      expectedCallMs: 13_000,
      logger: { log: (entry: LogEntry) => void entries.push(entry) },
    });
    let finishCall = (): void => undefined;
    const inFlight = new Promise<void>((resolve) => {
      finishCall = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await inFlight;
      return new Response(JSON.stringify(responsesBody()), { status: 200, statusText: 'OK' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = new XSearchClient({ ...OPTIONS, gate }).fetchSentiment('TSLA', AS_OF);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await expect(gate.acquire({ budgetMs: 28_000, llmStage: 'debate' })).rejects.toBeInstanceOf(
      LlmInFlightRefusedError,
    );
    expect(entries.find((entry) => entry.event === 'llm_gate_refused')?.payload).toMatchObject({
      estimated_wait_ms: 26_000,
    });

    finishCall();
    await pending;
  });
});
