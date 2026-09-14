/**
 * `GrokAgent` (#464) — the cadence cache, the spend gate, and the degradation
 * path. The three properties that make this affordable to leave running.
 */
import type { SpendCap } from '../../../pipeline/debate-engine/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import { UNGATED_LLM_IN_FLIGHT } from '../../../shared/llm/index.js';
import type { LogEntry, Logger } from '../../../shared/types.js';
import { MiArchiveStore } from '../archive/mi-archive-store.js';
import { MarketIntelligenceStore } from '../index.js';
import type { IntelligenceItem } from '../types.js';
import {
  floorToRefreshBucket,
  GROK_REFRESH_MS,
  GrokAgent,
  type GrokSpendSink,
} from './grok-agent.js';
import { NousSentimentClient } from './nous-sentiment-client.js';

const START = new Date('2026-08-06T00:00:00Z');
/** `Duration` is a plain ms number — the same 24h the analysts read. */
const WINDOW_24H = 24 * 60 * 60 * 1000;

function item(id: string): IntelligenceItem {
  return {
    id,
    source: 'twitter',
    type: 'sentiment',
    timestamp: START,
    entity: 'BTC-USD',
    headline: 'crowd is bullish',
    sentiment: 1,
    confidence: 0.7,
  };
}

const ADMITS: SpendCap = {
  check: () => ({ admitted: true, spent_usd: 1, budget_usd: 50 }),
};
const REFUSES: SpendCap = {
  check: () => ({
    admitted: false,
    spent_usd: 50,
    budget_usd: 50,
    reason: 'budget exhausted',
    kind: 'budget',
  }),
};

function recordingSink(): GrokSpendSink & { calls: number } {
  const sink = {
    calls: 0,
    record() {
      sink.calls++;
    },
  };
  return sink;
}

function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

function build(
  options: {
    spendCap?: SpendCap;
    fail?: boolean;
    /** Defaults `true` so existing tests exercise real, trusted retrieval. */
    retrievalEvidence?: boolean;
    /** Defaults to one item per call; pass `() => []` for the empty-answer shape. */
    items?: (fetchIndex: number) => IntelligenceItem[];
    logger?: Logger;
    archive?: MiArchiveStore;
  } = {},
) {
  const clock = new SimulatedClock(START);
  const store = new MarketIntelligenceStore(clock);
  const sink = recordingSink();
  let fetches = 0;

  const agent = new GrokAgent({
    client: {
      async fetchSentiment() {
        fetches++;
        if (options.fail === true) throw new Error('xAI responded 503');
        return {
          items: (options.items ?? ((i: number) => [item(`i-${i}`)]))(fetches),
          model: 'grok-4.5',
          usage: { input_tokens: 100, output_tokens: 50 },
          retrievalEvidence: options.retrievalEvidence ?? true,
          latency_ms: 42,
        };
      },
    },
    store,
    spendCap: options.spendCap ?? ADMITS,
    spendSink: sink,
    clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.archive === undefined ? {} : { archive: options.archive }),
  });

  return { agent, clock, store, sink, fetches: () => fetches };
}

/** An item with an X permalink `toArchiveProjection` accepts, so `#archive` writes. */
function archivableItem(statusId: string): IntelligenceItem {
  return { ...item(`i-${statusId}`), url: `https://x.com/someone/status/${statusId}` };
}

describe('floorToRefreshBucket', () => {
  it('floors to the 2h grid, epoch-relative like floorToBar (#393)', () => {
    expect(floorToRefreshBucket(new Date('2026-08-06T01:59:59Z')).toISOString()).toBe(
      '2026-08-06T00:00:00.000Z',
    );
    expect(floorToRefreshBucket(new Date('2026-08-06T02:00:00Z')).toISOString()).toBe(
      '2026-08-06T02:00:00.000Z',
    );
  });

  it('is twelve buckets a day, which is the sample-size decision (#969)', () => {
    // This assertion used to read `=== 6`, deriving a 4h interval as 1/6th of
    // `MI_CONTEXT_WINDOW_MS` on a STALENESS argument. That argument was made
    // while nothing retrieved and the ingested item count was structurally
    // zero, so it was bounding the freshness of an empty set.
    //
    // With real retrieval the binding constraint is SAMPLE SIZE:
    // `sentiment-analyst.ts` averages `social` wholesale, so buckets x
    // results-per-bucket is what decides whether three bot posts can swing
    // the lens.
    //
    // The assertion below is on the CONSTANT — 12 buckets per 24 hours — not
    // on how many actually fire. The scheduler emits no instruments outside
    // the session, so a 6.5h US session touches 4 of them and the real sample
    // is 4 x 3 = 12 posts/instrument/session.
    //
    // Cost is the other half of the same decision and it is NOT slack: across
    // the 20-name universe (#1051) a soak is ~800 calls, ~$16 at the default
    // result count and ~$71 at the ceiling, against a $50 cap. Interval and
    // result count move together, and neither can be retuned alone. See
    // `x-search-client.ts`.
    expect((24 * 60 * 60 * 1000) / GROK_REFRESH_MS).toBe(12);
  });
});

describe('GrokAgent', () => {
  it('calls once per bucket, however many passes arrive inside it', async () => {
    // The property the whole cadence decision rests on: at a 15-minute tick
    // there are 8 passes per 2h bucket, and 7 of them must cost nothing.
    const { agent, clock, fetches } = build();

    expect(await agent.refresh('t1', 'BTC-USD', 'crypto')).toBe(true);
    clock.advanceTo(new Date(START.getTime() + 15 * 60_000));
    expect(await agent.refresh('t2', 'BTC-USD', 'crypto')).toBe(false);
    clock.advanceTo(new Date(START.getTime() + 75 * 60_000));
    expect(await agent.refresh('t3', 'BTC-USD', 'crypto')).toBe(false);

    expect(fetches()).toBe(1);
  });

  it('calls again once the bucket rolls', async () => {
    const { agent, clock, fetches } = build();

    await agent.refresh('t1', 'BTC-USD', 'crypto');
    clock.advanceTo(new Date(START.getTime() + GROK_REFRESH_MS));
    expect(await agent.refresh('t2', 'BTC-USD', 'crypto')).toBe(true);

    expect(fetches()).toBe(2);
  });

  it('buckets per instrument, not globally', async () => {
    const { agent, fetches } = build();

    await agent.refresh('t1', 'BTC-USD', 'crypto');
    await agent.refresh('t1', 'ETH-USD', 'crypto');

    expect(fetches()).toBe(2);
  });

  it('meters every call into the spend sink', async () => {
    // Without this the cap sums past xAI entirely and ADR-0008's ceiling is a
    // fiction for the second provider.
    const { agent, sink } = build();

    await agent.refresh('t1', 'BTC-USD', 'crypto');

    expect(sink.calls).toBe(1);
  });

  it('refuses BEFORE calling when the spend cap is exhausted', async () => {
    const { agent, sink, store, fetches } = build({ spendCap: REFUSES });

    expect(await agent.refresh('t1', 'BTC-USD', 'crypto')).toBe(false);

    // No call, no spend row, and — the part that matters — no item. The
    // analysts fall back to NO_DATA_MARKER, so "could not afford to look" stays
    // distinguishable from "looked and saw nothing".
    expect(fetches()).toBe(0);
    expect(sink.calls).toBe(0);
    expect(store.getContext('crypto', WINDOW_24H, 't1').social).toEqual([]);
  });

  it('does not throw when the call fails, and does not burn the bucket', async () => {
    // An xAI outage must degrade the debate to NO_DATA_MARKER, and one
    // transient failure must not buy a whole extra refresh bucket of silence
    // — the bucket is not marked on failure, so the next pass retries.
    const { agent, store, fetches } = build({ fail: true });

    expect(await agent.refresh('t1', 'BTC-USD', 'crypto')).toBe(false);
    expect(store.getContext('crypto', WINDOW_24H, 't1').social).toEqual([]);

    expect(await agent.refresh('t2', 'BTC-USD', 'crypto')).toBe(false);
    expect(fetches()).toBe(2);
  });

  it('ingests into the store the analysts read', async () => {
    const { agent, store } = build();

    await agent.refresh('t1', 'BTC-USD', 'crypto');

    const context = store.getContext('crypto', WINDOW_24H, 't1');
    expect(context.social).toHaveLength(1);
    expect(context.social[0]?.entity).toBe('BTC-USD');
  });

  describe('retrieval-evidence guard (#485)', () => {
    it('discards items that parsed cleanly but carry no evidence of retrieval', async () => {
      // A response that isn't tagged as retrieved cannot be told apart from
      // model recall, so it must not reach the analysts as signal — the same
      // NO_DATA_MARKER degradation as an outage, not a fabricated neutral read.
      const { agent, store } = build({ retrievalEvidence: false });

      await agent.refresh('t1', 'BTC-USD', 'crypto');

      expect(store.getContext('crypto', WINDOW_24H, 't1').social).toEqual([]);
    });

    it('still meters the call and marks the bucket when evidence is absent', async () => {
      // The call still cost money and still happened — only the ingest is
      // suppressed. Marking the bucket keeps a permanently-unretrieved client
      // (like NousSentimentClient) from being hammered every tick, and NOT
      // metering would let an un-retrieved-but-billed call under-count spend.
      const { agent, sink, fetches } = build({ retrievalEvidence: false });

      expect(await agent.refresh('t1', 'BTC-USD', 'crypto')).toBe(true);
      expect(sink.calls).toBe(1);

      await agent.refresh('t2', 'BTC-USD', 'crypto');
      expect(fetches()).toBe(1); // bucket held, no second call this window
    });

    it('logs a warning distinguishing "recalled, never looked" from an unreadable response', async () => {
      const logger = recordingLogger();
      const { agent } = build({ retrievalEvidence: false, logger });

      await agent.refresh('t1', 'BTC-USD', 'crypto');

      const warning = logger.entries.find((e) => e.level === 'warn');
      expect(warning?.message).toContain('no evidence of retrieval');
      expect(warning?.message).toContain('discarding');
      expect(warning?.payload).toMatchObject({ instrument: 'BTC-USD', discarded_items: 1 });
    });

    it('logs "could not look" at info, not warn, when there was nothing to discard', async () => {
      // This is the routine case in production today — NousSentimentClient
      // reports no evidence on every call, and today it also returns zero
      // items every call (see that client's header). It must still log,
      // because silence here would be indistinguishable from "looked and saw
      // nothing" — but `warn` on every one of ~36 calls/day for a known,
      // expected state would just train the log to be ignored.
      const logger = recordingLogger();
      const { agent } = build({ retrievalEvidence: false, items: () => [], logger });

      await agent.refresh('t1', 'BTC-USD', 'crypto');

      expect(logger.entries).toHaveLength(1);
      expect(logger.entries[0]?.level).toBe('info');
      expect(logger.entries[0]?.message).toContain('no retrieval evidence');
      expect(logger.entries[0]?.payload).toMatchObject({
        instrument: 'BTC-USD',
        discarded_items: 0,
      });
    });

    it('ingests when the client does supply retrieval evidence', async () => {
      // The seam option 3 restores: a client that sets retrievalEvidence:
      // true is trusted with no change to this file.
      const { agent, store } = build({ retrievalEvidence: true });

      await agent.refresh('t1', 'BTC-USD', 'crypto');

      expect(store.getContext('crypto', WINDOW_24H, 't1').social).toHaveLength(1);
    });
  });

  describe('#archive (#1342)', () => {
    class ThrowingArchive extends MiArchiveStore {
      override write(): never {
        throw new Error('disk full');
      }
    }

    it("logs the archive-write failure under the refresh call's own trace_id", async () => {
      const logger = recordingLogger();
      const { agent } = build({
        logger,
        archive: new ThrowingArchive(),
        items: () => [archivableItem('12345')],
      });

      await agent.refresh('caller-trace-9', 'BTC-USD', 'crypto');

      const entry = logger.entries.find((e) => e.event === 'grok_archive_write_failed');
      expect(entry).toBeDefined();
      expect(entry?.trace_id).toBe('caller-trace-9');
    });
  });

  // Wired against the REAL client rather than the fake above, because the
  // defect this pins lives in the seam between the two: the agent meters and
  // marks the bucket on a RETURN, so what the client does with a refusal
  // decides whether a refused call is counted once or re-issued every tick
  // (#1391).
  describe('a refused call, through the real Nous client (#1391)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function refusingFetch() {
      const fetchMock = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
              choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
              model: '~x-ai/grok-latest',
              usage: { prompt_tokens: 40, completion_tokens: 6 },
            }),
          }) as Response,
      );
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    function realClientAgent() {
      const clock = new SimulatedClock(START);
      const sink = recordingSink();
      const agent = new GrokAgent({
        client: new NousSentimentClient({
          apiKey: 'test-fake-nous-key',
          baseUrl: 'https://nous.test/v1',
          model: '~x-ai/grok-latest',
          gate: UNGATED_LLM_IN_FLIGHT,
        }),
        store: new MarketIntelligenceStore(clock),
        spendCap: ADMITS,
        spendSink: sink,
        clock,
      });
      return { agent, clock, sink };
    }

    it('meters the refusal, so the tokens it billed count against the cap', async () => {
      const fetchMock = refusingFetch();
      const { agent, sink } = realClientAgent();

      await agent.refresh('t1', 'BTC-USD', 'crypto');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sink.calls).toBe(1);
    });

    it('marks the bucket, so the same refused prompt is not re-issued every tick', async () => {
      const fetchMock = refusingFetch();
      const { agent, clock } = realClientAgent();

      await agent.refresh('t1', 'BTC-USD', 'crypto');
      clock.advanceTo(new Date(START.getTime() + 15 * 60_000));
      await agent.refresh('t2', 'BTC-USD', 'crypto');
      clock.advanceTo(new Date(START.getTime() + 30 * 60_000));
      await agent.refresh('t3', 'BTC-USD', 'crypto');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still leaves a transient failure retryable, bucket unmarked', async () => {
      // The carve-out must stay narrow: a 503 is not deterministic in the
      // prompt, and the next pass must still pay to look again.
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
      const { agent, clock } = realClientAgent();

      await agent.refresh('t1', 'BTC-USD', 'crypto');
      clock.advanceTo(new Date(START.getTime() + 15 * 60_000));
      await agent.refresh('t2', 'BTC-USD', 'crypto');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
