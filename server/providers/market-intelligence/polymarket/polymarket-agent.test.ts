import { describe, expect, it, vi } from 'vitest';
import type { Clock, Logger } from '../../../shared/index.js';
import { MiArchiveStore } from '../archive/mi-archive-store.js';
import { MarketIntelligenceStore } from '../index.js';
import type { CuratedMacroMarket } from './curated-markets.js';
import {
  POLYMARKET_ASSET_CLASS,
  PolymarketAgent,
  SOURCE_POLYMARKET,
  toArchivedItem,
} from './polymarket-agent.js';
import type { PolymarketMarket, PolymarketPricePoint } from './polymarket-client.js';

const NOW = new Date('2026-08-17T12:00:00Z');
const clock: Clock = { now: () => NOW };

const ENTRY: CuratedMacroMarket = {
  id: 'fed-2026-09',
  eventSlug: 'fed-decision-in-september-762',
  marketSlug: 'will-the-fed-increase-rates-25bps-september',
  bullishOutcome: 'No',
  entity: 'FOMC-2026-09',
  label: 'P(no 25bp hike at the September 2026 FOMC)',
  rationale: 'A hike is bearish for a levered long book.',
};

function market(overrides: Partial<PolymarketMarket> = {}): PolymarketMarket {
  return {
    slug: ENTRY.marketSlug,
    question: 'Will the Fed increase interest rates by 25 bps?',
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.295, 0.705],
    tokenIds: ['token-yes', 'token-no'],
    bestBid: 0.7,
    bestAsk: 0.71,
    spread: 0.01,
    volume24hr: 533_307,
    liquidity: 2_149_190,
    updatedAt: new Date('2026-08-17T11:55:00Z'),
    closed: false,
    payload: '{"slug":"m"}',
    ...overrides,
  };
}

/** A 24h hourly series ending `at` NOW, running from `from` to `to` */
function history(from: number, to: number, hours = 24): PolymarketPricePoint[] {
  const points: PolymarketPricePoint[] = [];
  for (let index = 0; index <= hours; index += 1) {
    const at = new Date(NOW.getTime() - (hours - index) * 60 * 60 * 1000);
    const probability = from + ((to - from) * index) / hours;
    points.push({ at, probability });
  }
  return points;
}

function agentWith(options: {
  market?: PolymarketMarket | undefined;
  history?: PolymarketPricePoint[];
  marketError?: Error;
  historyError?: Error;
  table?: readonly CuratedMacroMarket[];
  archive?: MiArchiveStore;
  logger?: Logger;
}) {
  const store = new MarketIntelligenceStore(clock);
  const fetchEventMarket = vi.fn(async () => {
    if (options.marketError) throw options.marketError;
    return 'market' in options ? options.market : market();
  });
  const fetchPriceHistory = vi.fn(async () => {
    if (options.historyError) throw options.historyError;
    return options.history ?? history(0.67, 0.705);
  });
  const agent = new PolymarketAgent({
    client: { fetchEventMarket, fetchPriceHistory },
    store,
    clock,
    table: options.table ?? [ENTRY],
    ...(options.archive === undefined ? {} : { archive: options.archive }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return { agent, store, fetchEventMarket, fetchPriceHistory };
}

function intelFor(store: MarketIntelligenceStore) {
  return store.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'test').intel;
}

describe('PolymarketAgent.refresh', () => {
  it('ingests one news item per curated event, signed by the 24h delta', async () => {
    const { agent, store } = agentWith({ history: history(0.67, 0.705) });

    await expect(agent.refresh('t1')).resolves.toBe(true);

    const intel = intelFor(store);
    expect(intel).toHaveLength(1);
    expect(intel[0]).toMatchObject({
      source: SOURCE_POLYMARKET,
      type: 'news',
      entity: 'FOMC-2026-09',
      sentiment: 1,
    });
    // 0.035 delta * 5 = 0.175
    expect(intel[0]?.confidence).toBeCloseTo(0.175, 6);
    expect(intel[0]?.headline).toContain('0.670');
    expect(intel[0]?.headline).toContain('0.705');
  });

  /**
   * The read that matters. `intelFor` passes no entity, which is the shape of
   * NO production caller: `fundamental-analyst` and `sentiment-analyst` both
   * pass `resolveMiSubject(signal.asset)` (#914/#960), and a curated market is
   * filed under a macro series name that equals no ticker. Asserted through an
   * entity-scoped read rather than on the item's `scope` field, because the
   * defect this guards was a whole adopted feed reaching no analyst while
   * every construction-shaped assertion above stayed green.
   */
  it('reaches an ENTITY-SCOPED read, the only kind an analyst performs', async () => {
    const { agent, store } = agentWith({});

    await agent.refresh('t1');

    const scoped = store.getContext(
      POLYMARKET_ASSET_CLASS,
      24 * 60 * 60 * 1000,
      'test',
      undefined,
      'SPY',
    );

    expect(scoped.intel.map((item) => item.entity)).toEqual(['FOMC-2026-09']);
  });

  it('reads the delta on the BULLISH outcome token, not the first one', async () => {
    const { agent, fetchPriceHistory } = agentWith({});

    await agent.refresh('t1');

    expect(fetchPriceHistory).toHaveBeenCalledWith('token-no');
  });

  it('signs a falling bullish probability as bearish', async () => {
    const { agent, store } = agentWith({ history: history(0.705, 0.5) });

    await agent.refresh('t1');

    expect(intelFor(store)[0]?.sentiment).toBe(-1);
    // |delta| = 0.205 -> 1.025, clamped to the 0.95 ceiling
    expect(intelFor(store)[0]?.confidence).toBe(0.95);
  });

  it('emits sentiment 0 inside the dead band — "we looked and it did not move"', async () => {
    const { agent, store } = agentWith({ history: history(0.7, 0.71) });

    await agent.refresh('t1');

    expect(intelFor(store)[0]?.sentiment).toBe(0);
    expect(intelFor(store)[0]?.confidence).toBeCloseTo(0.05, 6);
  });

  it('stamps the item at the INGEST INSTANT, not the floored bucket (#782)', async () => {
    const { agent, store } = agentWith({});

    await agent.refresh('t1');

    // `NOW` is on the hour, so this is the one instant at which the two
    // candidate stamps agree — the discriminating case is the mid-bar one
    // below, and this only pins that nothing shifts the stamp off `now`
    expect(intelFor(store)[0]?.timestamp).toEqual(NOW);
  });

  /**
   * The regression #782 fixed, re-entering through a second writer.
   *
   * `getContext` sets `windowEnd = floorToBar(asOf, 1h)` and drops anything
   * stamped past it, precisely so `intel.length` (#1164; this item routes
   * there, not into `news`) cannot move within one debate bar. Three things
   * read that count: `technical-analyst` puts it verbatim in
   * `key_points`, which is hashed into `debate_id` — so a count that changes
   * mid-bar produces a second `debate_id` on a bar that already had one, misses
   * #617's same-bar short-circuit and pays for a SECOND debate against ADR-0008's
   * budget; and `fundamental-analyst` derives a second, different confidence
   * from the same bar, which `scale_in_conviction_delta` can turn into an extra
   * lot.
   *
   * Stamping the item at the floored bucket backdates it INTO the already-open
   * bar and does exactly that. `market-intelligence-spec.md` states the accepted
   * contract in one line: "an item ingested mid-bar is not visible until the
   * next bar opens."
   */
  it('is invisible for the rest of the bar it was ingested into (#782)', async () => {
    const midBar = new Date('2026-08-17T10:11:00Z');
    let asOf = midBar;
    const movingClock: Clock = { now: () => asOf };
    const store = new MarketIntelligenceStore(movingClock);
    const agent = new PolymarketAgent({
      client: {
        fetchEventMarket: async () => market({ updatedAt: new Date('2026-08-17T10:08:00Z') }),
        // A 24h series ending at the mid-bar instant, so the history-span guard
        // passes against the moving clock rather than against `NOW`
        fetchPriceHistory: async () =>
          Array.from({ length: 25 }, (_, index) => ({
            at: new Date(midBar.getTime() - (24 - index) * 60 * 60 * 1000),
            probability: 0.67 + (0.035 * index) / 24,
          })),
      },
      store,
      clock: movingClock,
      table: [ENTRY],
    });

    await expect(agent.refresh('t1')).resolves.toBe(true);

    // Stamped when it was ingested, not backdated to 10:00
    const stored = store.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'test');
    expect(stored.last_updated).toEqual(midBar);

    // Still 10:11 — same bar, and the count the debate hashes must not have
    // moved. Reading through `getContext` rather than the item is the point:
    // this is a statement about what the ANALYST sees
    expect(
      store.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'test').intel,
    ).toHaveLength(0);

    // 10:59 — the bar has not closed, so it is still invisible
    asOf = new Date('2026-08-17T10:59:59Z');
    expect(
      store.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'test').intel,
    ).toHaveLength(0);

    // 11:00 — the next bar opens and the item becomes visible, once, for good
    asOf = new Date('2026-08-17T11:00:00Z');
    expect(
      store.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'test').intel,
    ).toHaveLength(1);
  });

  it('does not re-fetch inside the same hourly bucket', async () => {
    const { agent, fetchEventMarket } = agentWith({});

    await agent.refresh('t1');
    await expect(agent.refresh('t2')).resolves.toBe(false);

    expect(fetchEventMarket).toHaveBeenCalledTimes(1);
  });

  it('archives the raw market bytes AND the derived items (#835)', async () => {
    const archive = new MiArchiveStore();
    const { agent } = agentWith({ archive });

    await agent.refresh('t1');

    expect(archive.rawRows(SOURCE_POLYMARKET)).toHaveLength(1);
    // Reads `mi_items`, not the raw table: writing `[]` for the items is the
    // exact defect #835 fixed, and only an items read can see it
    const archived = archive.itemsKnownAt(POLYMARKET_ASSET_CLASS, NOW, [SOURCE_POLYMARKET]);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.source).toBe(SOURCE_POLYMARKET);
    archive.close();
  });

  /**
   * `mi_items` foreign-keys `(source, native_id, updated_at)` into
   * `mi_archive_raw`, and the store leaves `PRAGMA foreign_keys` at SQLite's
   * default of OFF — so a drifted key would not throw, it would silently orphan
   * the item and break the provenance `retrievalEvidence` means (#555)
   */
  it('keys the archived item to its own raw row, so provenance links', async () => {
    const archive = new MiArchiveStore();
    const { agent } = agentWith({ archive });

    await agent.refresh('t1');

    const raw = archive.rawRows(SOURCE_POLYMARKET)[0];
    const served = archive.itemsKnownAt(POLYMARKET_ASSET_CLASS, NOW, [SOURCE_POLYMARKET])[0];
    expect(raw).toBeDefined();
    expect(served).toBeDefined();
    if (raw === undefined || served === undefined) return;

    // Asserted against `toArchivedItem` directly, NOT against what
    // `itemsKnownAt` serves: that read selects `asset_class, item_json` and
    // never touches the key columns, so a round-trip assertion would stay
    // green against a drifted `native_id` and prove nothing
    const archived = toArchivedItem(served, raw);
    expect(archived.source).toBe(raw.source);
    expect(archived.native_id).toBe(raw.native_id);
    expect(archived.updated_at.toISOString()).toBe(raw.updated_at.toISOString());
    expect(archived.ingested_at.toISOString()).toBe(raw.ingested_at.toISOString());
    archive.close();
  });
});

describe('PolymarketAgent fail-closed guards (#504 scope item 7)', () => {
  it('ingests nothing when the curated slug has rotted, and says so loudly', async () => {
    const log = vi.fn();
    const { agent, store } = agentWith({ market: undefined, logger: { log } });

    await expect(agent.refresh('t1')).resolves.toBe(false);

    expect(intelFor(store)).toHaveLength(0);
    const warned = log.mock.calls.map(([entry]) => entry).filter((e) => e.level === 'warn');
    expect(warned.some((e) => String(e.message).includes('fed-2026-09'))).toBe(true);
  });

  it('ingests nothing when the fetch fails, and retries on the next refresh', async () => {
    const { agent, store, fetchEventMarket } = agentWith({
      marketError: new Error('ECONNRESET'),
    });

    await expect(agent.refresh('t1')).resolves.toBe(false);
    expect(intelFor(store)).toHaveLength(0);

    // The bucket is NOT marked, so a transient failure does not buy an hour of
    // silence
    await agent.refresh('t2');
    expect(fetchEventMarket).toHaveBeenCalledTimes(2);
  });

  /**
   * Gamma and the CLOB are independent endpoints (`gamma-api.polymarket.com`
   * and `clob.polymarket.com`), so "Gamma healthy, CLOB down" is an ordinary
   * outage rather than a contrived one. The Gamma-side throw is already handled
   * as transient — it does not count as an answer and leaves the bucket
   * unmarked, which is what makes the next pass retry. The CLOB-side throw must
   * be treated the same way: a transport failure is not an answer just because
   * a DIFFERENT transport answered first. Crediting it marks the bucket and
   * buys an hour of silence on an outage that may have lasted seconds.
   */
  it('retries after a CLOB outage rather than marking the hour answered', async () => {
    const { agent, store, fetchEventMarket } = agentWith({
      historyError: new Error('clob 503'),
    });

    await expect(agent.refresh('t1')).resolves.toBe(false);
    expect(intelFor(store)).toHaveLength(0);

    // The bucket is NOT marked, so the next pass re-asks — the same contract
    // the Gamma-side transport failure above holds to
    await agent.refresh('t2');
    expect(fetchEventMarket).toHaveBeenCalledTimes(2);
  });

  /**
   * The other side of the same line, so the fix above cannot be "never mark the
   * bucket". A row REFUSED on book quality is a real answer — the vendor was
   * reachable and the book was thin — and re-asking within the hour would only
   * repeat it.
   */
  it('still marks the hour answered when every row was refused on book quality', async () => {
    const { agent, fetchEventMarket } = agentWith({ market: market({ volume24hr: 5 }) });

    await expect(agent.refresh('t1')).resolves.toBe(false);

    await agent.refresh('t2');
    expect(fetchEventMarket).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a closed market', { closed: true }],
    ['a wide spread', { spread: 0.3, bestBid: 0.5, bestAsk: 0.8 }],
    ['thin 24h volume', { volume24hr: 5 }],
    ['absent 24h volume', { volume24hr: undefined }],
    ['thin liquidity', { liquidity: 10 }],
    ['a stale vendor stamp', { updatedAt: new Date('2026-08-16T00:00:00Z') }],
    ['no vendor stamp at all', { updatedAt: undefined }],
    ['no live book', { bestBid: undefined, bestAsk: undefined, spread: undefined }],
  ])('refuses to ingest on %s', async (_name, overrides) => {
    const { agent, store } = agentWith({ market: market(overrides) });

    await agent.refresh('t1');

    expect(intelFor(store)).toHaveLength(0);
  });

  it('escalates a permanently-refused row from info to warn after a day of passes', async () => {
    // The silent-decay hazard: a row parked below the volume floor never
    // contributes and never warns. Measured 2026-08-17, 5 of the 8 shipped rows
    // sit there, so this is the common case
    const log = vi.fn();
    let at = new Date('2026-08-17T00:00:00Z');
    const store = new MarketIntelligenceStore({ now: () => at });
    const agent = new PolymarketAgent({
      client: {
        fetchEventMarket: async () => market({ volume24hr: 5, updatedAt: at }),
        fetchPriceHistory: async () => [],
      },
      store,
      clock: { now: () => at },
      table: [ENTRY],
      logger: { log },
    });

    const levelsPerPass: string[] = [];
    for (let pass = 0; pass < 24; pass += 1) {
      at = new Date(at.getTime() + 60 * 60 * 1000);
      log.mockClear();
      await agent.refresh(`t${pass}`);
      const refusal = log.mock.calls
        .map(([entry]) => entry)
        .find((entry) => String(entry.message).includes(ENTRY.id));
      levelsPerPass.push(String(refusal?.level));
    }

    expect(levelsPerPass.slice(0, 23).every((level) => level === 'info')).toBe(true);
    expect(levelsPerPass[23]).toBe('warn');
  });

  it('resets the refusal streak once the row answers again', async () => {
    const log = vi.fn();
    let at = new Date('2026-08-17T00:00:00Z');
    let thin = true;
    const store = new MarketIntelligenceStore({ now: () => at });
    const agent = new PolymarketAgent({
      client: {
        fetchEventMarket: async () =>
          thin ? market({ volume24hr: 5, updatedAt: at }) : market({ updatedAt: at }),
        fetchPriceHistory: async () =>
          history(0.67, 0.705).map((point) => ({
            ...point,
            at: new Date(point.at.getTime() + (at.getTime() - NOW.getTime())),
          })),
      },
      store,
      clock: { now: () => at },
      table: [ENTRY],
      logger: { log },
    });

    for (let pass = 0; pass < 23; pass += 1) {
      at = new Date(at.getTime() + 60 * 60 * 1000);
      await agent.refresh(`t${pass}`);
    }
    thin = false;
    at = new Date(at.getTime() + 60 * 60 * 1000);
    await agent.refresh('healthy');
    thin = true;
    at = new Date(at.getTime() + 60 * 60 * 1000);
    log.mockClear();
    await agent.refresh('again');

    const refusal = log.mock.calls
      .map(([entry]) => entry)
      .find((entry) => String(entry.message).includes(ENTRY.id));
    expect(refusal?.level).toBe('info');
  });

  /**
   * The #1120 regression: `#refusals` is an in-memory `Map`, so a restart
   * used to reset a row's streak to 1 no matter how long it had been dead —
   * `us-recession-2026` reached 12 in one process's lifetime and reset on the
   * next boot, which is exactly what let a permanently-refusing row read as
   * merely occasional on a soak that bounces more than once a day. Two
   * SEPARATE `PolymarketAgent` instances sharing one archive is the fixture
   * for "a restart happened": the second agent's in-memory map starts empty,
   * the way a fresh process's does.
   */
  it('resumes a refusal streak from the archive after a simulated restart', async () => {
    const archive = new MiArchiveStore();
    let at = new Date('2026-08-17T00:00:00Z');
    const store = new MarketIntelligenceStore({ now: () => at });
    const client = {
      fetchEventMarket: async () => market({ volume24hr: 5, updatedAt: at }),
      fetchPriceHistory: async () => [],
    };

    const beforeRestart = new PolymarketAgent({
      client,
      store,
      clock: { now: () => at },
      table: [ENTRY],
      archive,
    });
    for (let pass = 0; pass < 12; pass += 1) {
      at = new Date(at.getTime() + 60 * 60 * 1000);
      await beforeRestart.refresh(`before-${pass}`);
    }
    expect(archive.refusalStreak(SOURCE_POLYMARKET, ENTRY.id)).toBe(12);

    // A brand-new instance, sharing only the archive — the in-memory `#refusals`
    // map this process never populated
    const log = vi.fn();
    const afterRestart = new PolymarketAgent({
      client,
      store,
      clock: { now: () => at },
      table: [ENTRY],
      archive,
      logger: { log },
    });
    for (let pass = 0; pass < 12; pass += 1) {
      at = new Date(at.getTime() + 60 * 60 * 1000);
      log.mockClear();
      await afterRestart.refresh(`after-${pass}`);
    }

    // 24 total passes across the restart, not 12 — the escalation threshold
    // fires on this pass rather than needing a further 24 in the new process
    expect(archive.refusalStreak(SOURCE_POLYMARKET, ENTRY.id)).toBe(24);
    const refusal = log.mock.calls
      .map(([entry]) => entry)
      .find((entry) => String(entry.message).includes(ENTRY.id));
    expect(refusal?.level).toBe('warn');
    expect(refusal?.payload).toMatchObject({ consecutive_refusals: 24 });
    archive.close();
  });

  it('clears the persisted streak once a row answers again, across a restart', async () => {
    const archive = new MiArchiveStore();
    let at = new Date('2026-08-17T00:00:00Z');
    const store = new MarketIntelligenceStore({ now: () => at });

    const beforeRestart = new PolymarketAgent({
      client: {
        fetchEventMarket: async () => market({ volume24hr: 5, updatedAt: at }),
        fetchPriceHistory: async () => [],
      },
      store,
      clock: { now: () => at },
      table: [ENTRY],
      archive,
    });
    at = new Date(at.getTime() + 60 * 60 * 1000);
    await beforeRestart.refresh('t1');
    expect(archive.refusalStreak(SOURCE_POLYMARKET, ENTRY.id)).toBe(1);

    // The row answers on the second agent — simulating the market recovering
    // after a restart, not just within the process that saw it refuse
    const log = vi.fn();
    const afterRestart = new PolymarketAgent({
      client: {
        fetchEventMarket: async () => market({ updatedAt: at }),
        fetchPriceHistory: async () =>
          history(0.67, 0.705).map((point) => ({
            ...point,
            at: new Date(point.at.getTime() + (at.getTime() - NOW.getTime())),
          })),
      },
      store,
      clock: { now: () => at },
      table: [ENTRY],
      archive,
      logger: { log },
    });
    at = new Date(at.getTime() + 60 * 60 * 1000);
    await afterRestart.refresh('t2');

    expect(archive.refusalStreak(SOURCE_POLYMARKET, ENTRY.id)).toBe(0);
    archive.close();
  });

  it('refuses when the price history does not span a full 24h', async () => {
    // Three hours of history: a large move over it would otherwise land as a
    // HIGH-confidence signal built on almost no data
    const { agent, store } = agentWith({ history: history(0.4, 0.7, 3) });

    await agent.refresh('t1');

    expect(intelFor(store)).toHaveLength(0);
  });

  it('refuses when the latest history point is stale', async () => {
    const stale = history(0.67, 0.705).map((point) => ({
      ...point,
      at: new Date(point.at.getTime() - 5 * 60 * 60 * 1000),
    }));
    const { agent, store } = agentWith({ history: stale });

    await agent.refresh('t1');

    expect(intelFor(store)).toHaveLength(0);
  });

  it('refuses when the curated bullish outcome is not one of the market outcomes', async () => {
    const { agent, store } = agentWith({ market: market({ outcomes: ['Up', 'Down'] }) });

    await agent.refresh('t1');

    expect(intelFor(store)).toHaveLength(0);
  });

  it('refuses a row whose bullish outcome is pinned near certainty, before the CLOB call', async () => {
    // 0.9945 is `us-cpi-annual-hot-tail` as measured on 2026-08-17 (#833)
    // The history below moves 0.0245 — past the ±0.02 dead band — so without
    // the pinned guard this row WOULD emit an item, and the assertion is not
    // passing for the trivial reason that nothing moved
    const { agent, store, fetchPriceHistory } = agentWith({
      market: market({ outcomePrices: [0.0055, 0.9945], bestBid: 0.99, bestAsk: 0.995 }),
      history: history(0.97, 0.9945),
    });

    await expect(agent.refresh('t1')).resolves.toBe(false);

    expect(intelFor(store)).toHaveLength(0);
    // The guard sits above the price-history fetch, so a pinned row costs no
    // CLOB call at all
    expect(fetchPriceHistory).not.toHaveBeenCalled();
  });

  it('refuses at 0.075 of headroom and ingests at 0.10 — the bound itself, not just the extremes', async () => {
    // 0.925 is `us-recession-2026` as measured on 2026-08-17: headroom 0.075,
    // inside the bound, so it is refused. This is the case that goes red if
    // MIN_PROBABILITY_HEADROOM is loosened. (That row later drifted to 0.935
    // and was removed by #1120 — see curated-markets.ts — but the boundary
    // value is still worth pinning on its own.)
    const marginal = agentWith({
      market: market({ outcomePrices: [0.075, 0.925], bestBid: 0.92, bestAsk: 0.93 }),
      history: history(0.88, 0.925),
    });
    await marginal.agent.refresh('t1');
    expect(intelFor(marginal.store)).toHaveLength(0);

    // Exactly at the bound: headroom 0.10 is admitted, so the guard cannot be
    // tightened without this going red either
    const atBound = agentWith({
      market: market({ outcomePrices: [0.1, 0.9], bestBid: 0.89, bestAsk: 0.9 }),
      history: history(0.86, 0.9),
    });
    await expect(atBound.agent.refresh('t2')).resolves.toBe(true);
    expect(intelFor(atBound.store)).toHaveLength(1);
  });

  it('applies the pinned guard to the SHIPPED table, with no table override', async () => {
    // The dominant defect class here is a guard nothing calls. This agent is
    // constructed the way `production.ts` constructs it — no `table` — so it
    // reads CURATED_MACRO_MARKETS itself. Every shipped row is served the same
    // healthy-but-pinned book; if the guard were not wired to the default
    // table, all of them would ingest
    const store = new MarketIntelligenceStore(clock);
    const fetchPriceHistory = vi.fn(async () => history(0.97, 0.9945));
    const agent = new PolymarketAgent({
      client: {
        fetchEventMarket: async (_eventSlug: string, marketSlug: string) =>
          market({
            slug: marketSlug,
            outcomePrices: [0.0055, 0.9945],
            bestBid: 0.99,
            bestAsk: 0.995,
          }),
        fetchPriceHistory,
      },
      store,
      clock,
    });

    await expect(agent.refresh('t1')).resolves.toBe(false);

    expect(intelFor(store)).toHaveLength(0);
    expect(fetchPriceHistory).not.toHaveBeenCalled();
  });

  it('keeps the surviving rows when one curated row fails', async () => {
    const second: CuratedMacroMarket = { ...ENTRY, id: 'second', entity: 'US-CPI-YOY' };
    const store = new MarketIntelligenceStore(clock);
    const fetchEventMarket = vi.fn(async (_eventSlug: string, marketSlug: string) => {
      if (marketSlug === 'rotted') return undefined;
      return market();
    });
    const agent = new PolymarketAgent({
      client: { fetchEventMarket, fetchPriceHistory: async () => history(0.67, 0.705) },
      store,
      clock,
      table: [{ ...ENTRY, marketSlug: 'rotted' }, second],
    });

    await expect(agent.refresh('t1')).resolves.toBe(true);

    expect(intelFor(store).map((item) => item.entity)).toEqual(['US-CPI-YOY']);
  });

  it('never throws when the store write itself fails', async () => {
    const store = new MarketIntelligenceStore(clock);
    vi.spyOn(store, 'ingest').mockImplementation(() => {
      throw new Error('store closed');
    });
    const agent = new PolymarketAgent({
      client: {
        fetchEventMarket: async () => market(),
        fetchPriceHistory: async () => history(0.67, 0.705),
      },
      store,
      clock,
      table: [ENTRY],
    });

    await expect(agent.refresh('t1')).resolves.toBe(false);
  });
});

describe('PolymarketAgent.whenIdle', () => {
  it('resolves after an in-flight refresh settles', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new MarketIntelligenceStore(clock);
    const agent = new PolymarketAgent({
      client: {
        fetchEventMarket: async () => {
          await gate;
          return market();
        },
        fetchPriceHistory: async () => history(0.67, 0.705),
      },
      store,
      clock,
      table: [ENTRY],
    });

    const running = agent.refresh('t1');
    const idle = agent.whenIdle();
    release();
    await Promise.all([running, idle]);

    expect(intelFor(store)).toHaveLength(1);
  });

  it('does not start a second pass while one is in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchEventMarket = vi.fn(async () => {
      await gate;
      return market();
    });
    const store = new MarketIntelligenceStore(clock);
    const agent = new PolymarketAgent({
      client: { fetchEventMarket, fetchPriceHistory: async () => history(0.67, 0.705) },
      store,
      clock,
      table: [ENTRY],
    });

    const first = agent.refresh('t1');
    await expect(agent.refresh('t2')).resolves.toBe(false);
    release();
    await first;

    expect(fetchEventMarket).toHaveBeenCalledTimes(1);
  });
});
