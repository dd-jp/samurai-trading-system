/**
 * `GrokAgent` (#464) — the cadence cache, the spend gate, and the degradation
 * path. The three properties that make this affordable to leave running.
 */
import type { SpendCap } from '../../debate-engine/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { MarketIntelligenceStore } from '../index.js';
import type { IntelligenceItem } from '../types.js';
import {
  floorToRefreshBucket,
  GROK_REFRESH_MS,
  GrokAgent,
  type GrokSpendSink,
} from './grok-agent.js';

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

function build(options: { spendCap?: SpendCap; fail?: boolean } = {}) {
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
          items: [item(`i-${fetches}`)],
          model: 'grok-4',
          usage: { input_tokens: 100, output_tokens: 50 },
          latency_ms: 42,
        };
      },
    },
    store,
    spendCap: options.spendCap ?? ADMITS,
    spendSink: sink,
    clock,
  });

  return { agent, clock, store, sink, fetches: () => fetches };
}

describe('floorToRefreshBucket', () => {
  it('floors to the 4h grid, epoch-relative like floorToBar (#393)', () => {
    expect(floorToRefreshBucket(new Date('2026-08-06T03:59:59Z')).toISOString()).toBe(
      '2026-08-06T00:00:00.000Z',
    );
    expect(floorToRefreshBucket(new Date('2026-08-06T04:00:00Z')).toISOString()).toBe(
      '2026-08-06T04:00:00.000Z',
    );
  });

  it('is derived from the analysts 24h context window — six buckets a day', () => {
    // Not a round number picked for looks: 1/6th of `MI_CONTEXT_WINDOW_MS`
    // bounds staleness under 17% of what the window covers.
    expect((24 * 60 * 60 * 1000) / GROK_REFRESH_MS).toBe(6);
  });
});

describe('GrokAgent', () => {
  it('calls once per bucket, however many passes arrive inside it', async () => {
    // The property the whole cadence decision rests on: at a 15-minute tick
    // there are 16 passes per 4h bucket, and 15 of them must cost nothing.
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
    // Called from the tick path: an xAI outage must degrade the debate, not
    // fail a tick that would otherwise have traded. And one transient failure
    // must not buy four hours of silence.
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
});
