/**
 * `XaiGrokClient` — the wire, and the one property that makes its output
 * trustworthy: sentiment is only ingested when the response proves `x_search`
 * actually ran.
 *
 * The original #464 client had no tests at all, and shipped posting to
 * `/v1/chat/completions` with no `tools` — an endpoint whose `tools` field
 * accepts functions ONLY, so nothing was ever retrieved and Grok answered from
 * training data. These tests pin the request shape precisely because that
 * defect was invisible from the outside: the response looked exactly like a
 * real one.
 */
import type { LogEntry, Logger } from '../../shared/index.js';
import { XaiGrokClient } from './xai-client.js';

const AS_OF = new Date('2026-08-06T00:00:00Z');

function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => void entries.push(entry) };
}

/** A well-formed answer body, minus whatever the individual test is probing. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    output_text: JSON.stringify({
      items: [{ headline: 'crowd is bullish', sentiment: 1, confidence: 0.8, summary: 'up' }],
    }),
    citations: ['https://x.com/someone/status/1'],
    model: 'grok-4.5',
    usage: { input_tokens: 100, output_tokens: 20 },
    ...overrides,
  };
}

function stubFetch(response: Record<string, unknown>, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchStub = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
    } as Response;
  };
  return { calls, fetchStub };
}

function install(response: Record<string, unknown>, status = 200) {
  const { calls, fetchStub } = stubFetch(response, status);
  globalThis.fetch = fetchStub as unknown as typeof fetch;
  return calls;
}

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('XaiGrokClient request shape', () => {
  it('posts to /v1/responses with the x_search tool, not chat/completions', async () => {
    // THE defect this file exists for. `/v1/chat/completions` documents its
    // tools field as "Currently, only functions are supported as a tool", so a
    // request there retrieves nothing and Grok answers from training data —
    // model recall reaching the analysts as live sentiment. Server-side
    // x_search runs only on the Responses API.
    const calls = install(body());
    const client = new XaiGrokClient({ apiKey: 'k' });

    await client.fetchSentiment('BTC-USD', AS_OF);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.x.ai/v1/responses');

    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(sent.tools).toEqual([{ type: 'x_search' }]);
    // The Responses API names the prompt `input`; `messages` is the legacy field
    // and would be ignored, producing an empty prompt.
    expect(sent).toHaveProperty('input');
    expect(sent).not.toHaveProperty('messages');
  });

  it('sends the key in the Authorization header and never in the URL', async () => {
    const calls = install(body());

    await new XaiGrokClient({ apiKey: 'secret-key' }).fetchSentiment('BTC-USD', AS_OF);

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-key');
    expect(calls[0]?.url).not.toContain('secret-key');
  });

  it('reports the status only when the request fails, never the body', async () => {
    // The body can echo the request, and the request carries the key.
    install({ error: 'Bearer secret-key is invalid' }, 401);

    await expect(
      new XaiGrokClient({ apiKey: 'secret-key' }).fetchSentiment('BTC-USD', AS_OF),
    ).rejects.toThrow('xAI responded 401');
  });
});

describe('XaiGrokClient retrieval evidence', () => {
  it('discards the answer and logs an error when nothing proves x_search ran', async () => {
    // Fail-closed. A response with no citations and no tool step is the model
    // answering from memory; ingesting it would put fabricated sentiment in
    // front of the debate, and it would be indistinguishable from a real read.
    install(body({ citations: [] }));
    const logger = recordingLogger();

    const result = await new XaiGrokClient({ apiKey: 'k', logger }).fetchSentiment(
      'BTC-USD',
      AS_OF,
    );

    expect(result.items).toEqual([]);
    const error = logger.entries.find((entry) => entry.level === 'error');
    expect(error?.message).toContain('NO evidence that x_search ran');
  });

  it('still meters the call it discarded', async () => {
    // The call cost money whether or not its answer was usable. Usage must
    // survive the discard or the cap under-counts every unretrieved call.
    install(body({ citations: [] }));

    const result = await new XaiGrokClient({ apiKey: 'k' }).fetchSentiment('BTC-USD', AS_OF);

    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
  });

  it('accepts a tool step in the output as evidence when citations are absent', async () => {
    // The other accepted signal: the Responses API reports server-side tool
    // invocations inline. Either alone would be brittle, since xAI publishes no
    // response schema.
    install(
      body({
        citations: undefined,
        output: [
          { type: 'x_search_call' },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  items: [{ headline: 'bearish', sentiment: -1, confidence: 0.6 }],
                }),
              },
            ],
          },
        ],
        output_text: undefined,
      }),
    );

    const result = await new XaiGrokClient({ apiKey: 'k' }).fetchSentiment('BTC-USD', AS_OF);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.sentiment).toBe(-1);
  });
});

describe('XaiGrokClient response parsing', () => {
  it('reads usage under the Responses API names, falling back to the legacy ones', async () => {
    install(body({ usage: { prompt_tokens: 7, completion_tokens: 3 } }));

    const result = await new XaiGrokClient({ apiKey: 'k' }).fetchSentiment('BTC-USD', AS_OF);

    expect(result.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it('reports zero tokens rather than NaN when usage is missing entirely', async () => {
    // A NaN would poison `priceUsage` and land a NaN in `cost_usd`, which
    // `SpendCap` treats as a corrupt row.
    install(body({ usage: undefined }));

    const result = await new XaiGrokClient({ apiKey: 'k' }).fetchSentiment('BTC-USD', AS_OF);

    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('salvages a fenced JSON object rather than reporting nothing', async () => {
    install(
      body({
        output_text:
          'Here is what I found:\n```json\n{"items":[{"headline":"flat","sentiment":0,' +
          '"confidence":0.5}]}\n```',
      }),
    );

    const result = await new XaiGrokClient({ apiKey: 'k' }).fetchSentiment('BTC-USD', AS_OF);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.sentiment).toBe(0);
  });

  it('drops items whose sentiment or confidence is outside the domain', async () => {
    // A sentiment of 2 would flow into the analysts' arithmetic as a value the
    // type system says cannot exist.
    install(
      body({
        output_text: JSON.stringify({
          items: [
            { headline: 'bad sentiment', sentiment: 2, confidence: 0.5 },
            { headline: '', sentiment: 1, confidence: 0.5 },
            { headline: 'no confidence', sentiment: 1, confidence: 'high' },
            { headline: 'good', sentiment: 1, confidence: 1.4 },
          ],
        }),
      }),
    );

    const result = await new XaiGrokClient({ apiKey: 'k' }).fetchSentiment('BTC-USD', AS_OF);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.headline).toBe('good');
    // Clamped, not rejected — an over-confident number is still a usable read.
    expect(result.items[0]?.confidence).toBe(1);
  });

  it('caps how many items one call may contribute', async () => {
    install(
      body({
        output_text: JSON.stringify({
          items: Array.from({ length: 40 }, (_, i) => ({
            headline: `theme ${i}`,
            sentiment: 1,
            confidence: 0.5,
          })),
        }),
      }),
    );

    const result = await new XaiGrokClient({ apiKey: 'k' }).fetchSentiment('BTC-USD', AS_OF);

    expect(result.items).toHaveLength(10);
  });

  it('reports zero items and warns when the body cannot be parsed at all', async () => {
    install(body({ output_text: 'no json here at all' }));
    const logger = recordingLogger();

    const result = await new XaiGrokClient({ apiKey: 'k', logger }).fetchSentiment(
      'BTC-USD',
      AS_OF,
    );

    expect(result.items).toEqual([]);
    expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });
});

describe('XaiGrokClient construction', () => {
  it('refuses to construct without a key, rather than failing every fourth hour', async () => {
    expect(() => new XaiGrokClient({ apiKey: '   ' })).toThrow(/XAI_API_KEY is not set/);
  });
});
