/**
 * `XSearchClient` — the first client that actually retrieves (#969).
 *
 * The cases worth pinning are the ones where a wrong answer looks like a right
 * one: an item the model invented reading exactly like an item it retrieved, a
 * post from yesterday reading exactly like a post from this hour, and a
 * citation to somewhere that is not X reading exactly like evidence.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry, Logger } from '../../../shared/types.js';
import { parseStatusUrl, XSearchClient } from './x-search-client.js';

const OPTIONS = {
  apiKey: 'test-fake-nous-key',
  baseUrl: 'https://nous.test/v1',
  windowMs: 2 * 60 * 60 * 1000,
};

const AS_OF = new Date('2026-09-03T12:00:00Z');

/**
 * A status id whose snowflake-encoded timestamp is `at`.
 *
 * The inverse of the decode the client does, so a fixture can place a post at
 * an exact instant rather than hard-coding an opaque 19-digit literal whose
 * meaning nobody can check. BigInt throughout: these exceed
 * `Number.MAX_SAFE_INTEGER`, and a float round-trip would move the timestamp.
 */
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

/** A Responses-API body in the shape the live probe returned. */
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
    // THE OFFLINE PROOF that retrieval is genuine, and the same decode that
    // established it: the live probe's cited posts landed 40-80 seconds before
    // the response's own `created_at`. No training corpus contains a post from
    // forty seconds ago.
    const at = new Date('2026-09-03T11:50:00.000Z');
    expect(parseStatusUrl(`https://x.com/someone/status/${statusIdAt(at)}`)?.postedAt).toEqual(at);
  });

  it('tolerates a tracking suffix, because a post is the same post with one', () => {
    expect(parseStatusUrl(`${FRESH_URL}?s=20`)?.statusId).toBe(FRESH_ID);
    expect(parseStatusUrl(`${FRESH_URL}#anchor`)?.handle).toBe('trader_one');
  });

  it('rejects a URL that is not an X status permalink', () => {
    // A live probe returned annotations pointing at `timestampconvert.net`, so
    // "the response carried a citation" is not by itself evidence of anything.
    expect(parseStatusUrl('https://timestampconvert.net/?t=123')).toBeNull();
    expect(parseStatusUrl('https://x.com/trader_one')).toBeNull();
    expect(parseStatusUrl('https://notx.com/trader_one/status/1234567890')).toBeNull();
  });

  it('does not round a status id through a float', () => {
    // `Number('1962847362817364993')` loses the low digits, which would
    // corrupt both the decoded timestamp and the item id — and the item id is
    // what ingest-level dedupe matches on.
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
    // Day-granular on the wire — which is exactly why the real window is
    // enforced on the results instead.
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
    // The POST's time, not the fetch's — what makes the archive replayable on
    // the real publication axis.
    expect(result.items[0]?.timestamp).toEqual(new Date(AS_OF.getTime() - 10 * 60_000));
    expect(result.retrievalEvidence).toBe(true);
  });

  it('drops an item the response never cited, however well-formed', async () => {
    // THE GATE. A call can genuinely run the tool, cite one post, and still
    // list ten items — the other nine being the model padding from recall. A
    // call-level evidence flag would let all ten through on the strength of
    // the one.
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
    // The model cannot mint evidence by typing a URL — only by pointing at one
    // the tool actually returned. Here it points at the cited post using a
    // tracking suffix; the stored url is the canonical citation.
    stubFetch(
      responsesBody({ items: [item({ url: `${FRESH_URL}?s=46` })], citations: [FRESH_URL] }),
    );

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.items[0]?.url).toBe(FRESH_URL);
  });

  it('drops a cited post that falls outside the bucket window', async () => {
    // `from_date`/`to_date` are DAY-granular: a probe requesting six hours got
    // posts up to 19.3 hours old. The API cannot express the window, so the
    // client enforces it — otherwise a two-hour bucket silently reports
    // yesterday's mood as this hour's.
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
    // The distinction #485 exists to preserve. "No chatter about QQQ this
    // hour" is a real observation and must not read as "could not look" —
    // which is what setting the flag from surviving items would do.
    stubFetch(responsesBody({ items: [], citations: [FRESH_URL] }));

    const result = await new XSearchClient(OPTIONS).fetchSentiment('QQQ', AS_OF);

    expect(result.items).toEqual([]);
    expect(result.retrievalEvidence).toBe(true);
  });

  it('reports NO evidence when the tool did not run', async () => {
    stubFetch(responsesBody({ items: [item()], citations: [] }));

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    // `GrokAgent` discards the items on this flag; the client reports the
    // absence honestly rather than passing recall off as retrieval.
    expect(result.retrievalEvidence).toBe(false);
  });

  it('counts server tool calls, capped at what the caller authorised', async () => {
    // Nous reports tokens only — there is no search counter on the wire — so
    // this is a deliberate conservative upper bound. Wrong in the
    // over-charging direction, which is the safe one for a ceiling.
    stubFetch(
      responsesBody({ citations: [FRESH_URL, STALE_URL, 'https://x.com/c/status/1234567890'] }),
    );

    const result = await new XSearchClient({ ...OPTIONS, maxSearchResults: 2 }).fetchSentiment(
      'TSLA',
      AS_OF,
    );

    expect(result.server_tool_calls).toBe(2);
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
    // Search results ride in the prompt, so this is the soak's main cost
    // lever. Silently honouring a typed 100 would multiply the LLM bill by an
    // order of magnitude and be discovered as an exhausted budget days later.
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
    // Zero reaches the analysts as NO_DATA — an answer we cannot decode is not
    // an answer, and must not be distinguishable from an outage by accident.
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
    // Review round 1 (#1055). `JSON.parse` succeeding does not mean an object
    // came back: the literal `null` parses fine, and reading `.items` off it
    // throws a TypeError that escapes the parser entirely — converting "a
    // shape we cannot read" into an exception, which is exactly what the
    // parse-to-zero contract promises not to do.
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

  it('drops a malformed ITEM without losing the well-formed ones beside it', async () => {
    // Review round 1 (#1055). `items: [null]` is a well-formed array whose
    // element throws on the first field read. One bad element must cost that
    // element, not the whole response — nine good items and one null yields
    // nine, not an exception.
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
    // Review round 1 (#1055). Deriving the count from citations alone
    // under-counts in one specific case: a search that ran and found nothing
    // has zero citations and would bill zero, though the provider charges per
    // call. A cap fed an under-count is not a cap, so a reported tool-call
    // item is a floor under the citation count.
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
    // Still "we looked", which is the distinction #485 exists to preserve.
    expect(result.retrievalEvidence).toBe(false);
  });

  it('rejects a post that postdates the response citing it', async () => {
    // A citation cannot be to the future. One that appears to be is a decode
    // or clock fault, not a scoop.
    const future = `https://x.com/a/status/${statusIdAt(new Date(AS_OF.getTime() + 60_000))}`;
    stubFetch(responsesBody({ items: [item({ url: future })], citations: [future] }));

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.items).toEqual([]);
  });

  it('validates every scored field before it becomes an item', async () => {
    // A retrieved post is untrusted input that reaches the model server-side,
    // before any code here runs — so field validation is one of the few
    // mitigations that actually applies. A sentiment of 5 would otherwise flow
    // into the analysts' arithmetic on a value the type says cannot exist.
    stubFetch(
      responsesBody({
        items: [item({ sentiment: 5 }), item({ confidence: 'high' }), item({ headline: '' })],
        citations: [FRESH_URL],
      }),
    );

    const result = await new XSearchClient(OPTIONS).fetchSentiment('TSLA', AS_OF);

    expect(result.items).toEqual([]);
  });
});
