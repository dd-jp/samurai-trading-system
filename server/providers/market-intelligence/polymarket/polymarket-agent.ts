/**
 * Polymarket macro/event ingestion agent.
 *
 * Second source into `fundamental`: Alpaca News returns 0 items for the live
 * LSE-ETP universe (3USL/3LDE/SGLN) — a leveraged ETP has no company news, but
 * macro events move it.
 *
 * Ingests macro event markets, not price ladders on the underlying: a ladder
 * on an asset's own price is arbitraged off spot, so it carries no
 * independent information and would double-count `technical-analyst`'s bars.
 *
 * Signal is the 24h CHANGE in probability, never the level: `sentiment =
 * sign(delta)` with a dead band, `confidence = clamp(|delta| * 5, 0.05, 0.95)`.
 *
 * Fail-closed on a rotted slug, failed fetch, closed market, stale stamp, thin
 * book, or a pinned probability that cannot carry a 24h delta — these report
 * `NO_DATA_MARKER` rather than a fabricated neutral view. Deliberate
 * exception: a delta inside the dead band still emits (sentiment 0), because
 * "looked and it didn't move" is real information, unlike "could not look".
 *
 * History-span guard: confidence is a function of |delta| alone, so a market
 * minted a few hours ago that moved a lot would otherwise read as a
 * high-confidence signal built on almost no data.
 *
 * Known limitations, not fixed here: (1) does not close the LSE-ETP coverage
 * hole — items are filed under macro series names, not tickers, so
 * `hasCoverageFor` never matches them. (2) one direction for a whole asset
 * class (`scope: 'asset_class'`) even though a macro move can be bullish for
 * one instrument and bearish for another. (3) time-axis vote inflation is
 * bounded by `latestClassWideRestatementOnly` collapsing repeats on read, but
 * only within this source — combined with `news`, an hourly-replayed curated
 * row can outvote Alpaca's sparse items by an order of magnitude; harmless
 * today only because Alpaca returns 0 for the live universe.
 *
 * No spend plumbing: this path makes no LLM call and costs £0.
 */

import type {
  AssetClass,
  Clock,
  LogEntry,
  LogEntryTemplate,
  Logger,
} from '../../../shared/index.js';
import { logCaughtFailure, safeLog } from '../../../shared/index.js';
import type { ArchivedItem, MiArchiveStore, RawArchiveRow } from '../archive/mi-archive-store.js';
import { MI_SOURCES } from '../archive/mi-sources.js';
import type { MarketIntelligenceStore } from '../index.js';
import type { IntelligenceItem } from '../types.js';
import type { CuratedMacroMarket } from './curated-markets.js';
import { CURATED_MACRO_MARKETS } from './curated-markets.js';
import type { PolymarketMarket, PolymarketPricePoint } from './polymarket-client.js';

/** The `source` on every item and archive row this agent writes */
export const SOURCE_POLYMARKET = MI_SOURCES.polymarket;

/** Stocks only — crypto left Samurai's scope, so a crypto batch would ingest for debates that never run */
export const POLYMARKET_ASSET_CLASS: AssetClass = 'stocks';

/**
 * One hour = 1/24th of the analysts' 24h window. Derived from staleness, not
 * cost (unlike `GROK_REFRESH_MS`) — this path is free.
 */
const POLYMARKET_REFRESH_MS = 60 * 60 * 1000;

/** Below this |delta| the market did not move enough to call a direction */
const DEAD_BAND = 0.02;

/** `|delta| * 5` saturates the 0.95 ceiling at a 0.19 move */
const CONFIDENCE_SCALE = 5;
const MIN_CONFIDENCE = 0.05;
const MAX_CONFIDENCE = 0.95;

/**
 * Headroom `min(p, 1 - p)` a tracked outcome must have to be a signal source.
 * A pinned probability can never clear the dead band, so it would emit a
 * permanent zero vote that dilutes `directionFrom`'s unweighted mean instead
 * of casting no vote. Derived from the confidence formula:
 * `((MIN_CONFIDENCE + MAX_CONFIDENCE) / 2) / CONFIDENCE_SCALE = 0.10` — the
 * headroom needed to express at least mid-range confidence in both directions.
 */
const MIN_PROBABILITY_HEADROOM = 0.1;

/** Book-quality floors: a probability read off a book this thin is a guess, not a price */
const MAX_SPREAD = 0.05;
const MIN_VOLUME_24H_USD = 100;
const MIN_LIQUIDITY_USD = 5_000;

/** How stale the vendor's revision stamp may be — measured healthy stamps run under 4 minutes old */
const MAX_UPDATED_AGE_MS = 6 * 60 * 60 * 1000;

/** The delta's lookback. Matches the analysts' context window by construction. */
const DELTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Slack around exactly 24h ago — two points at hourly fidelity, not enough to admit a 3h-old market */
const BASELINE_TOLERANCE_MS = 2 * 60 * 60 * 1000;

/** Consecutive refusals before escalating `info` to `warn` — 24 = one day at the hourly cadence */
const REFUSAL_WARN_STREAK = 24;

/** How stale the newest history point may be before the series is refused */
const MAX_LATEST_POINT_AGE_MS = 3 * 60 * 60 * 1000;

/** The two client calls this agent makes. Structurally satisfied by `PolymarketClient`. */
export interface PolymarketWireClient {
  fetchEventMarket(eventSlug: string, marketSlug: string): Promise<PolymarketMarket | undefined>;
  fetchPriceHistory(tokenId: string): Promise<PolymarketPricePoint[]>;
}

export interface PolymarketAgentDeps {
  client: PolymarketWireClient;
  store: MarketIntelligenceStore;
  clock: Clock;
  /** Durable copy of each row's refusal streak, so a restart resumes an escalation instead of restarting at 1 */
  archive?: MiArchiveStore | undefined;
  logger?: Logger | undefined;
  /** Overridable for tests; defaults to the reviewed table */
  table?: readonly CuratedMacroMarket[];
  /** Overridable for tests; defaults to the derived 1h */
  refreshMs?: number;
}

/** Epoch-relative, matching `floorToBar`'s rule, so a replay stepping the same grid lands on the same coordinate */
function floorToPolymarketBucket(at: Date, refreshMs: number = POLYMARKET_REFRESH_MS): Date {
  return new Date(Math.floor(at.getTime() / refreshMs) * refreshMs);
}

/** The three-valued sign the contract carries, with the dead band applied */
function signOfDelta(delta: number): 1 | 0 | -1 {
  if (delta > DEAD_BAND) return 1;
  if (delta < -DEAD_BAND) return -1;
  return 0;
}

/**
 * Whether a quoted probability sits too near 0 or 1 to carry a 24h delta.
 * See `MIN_PROBABILITY_HEADROOM` for the derivation of the bound.
 */
function isPinnedProbability(probability: number): boolean {
  // `1 - 0.9` is 0.09999999999999998 in binary float, so a bare `<` would
  // refuse a market quoted exactly at the bound; the 1e-9 slack fixes that
  return Math.min(probability, 1 - probability) < MIN_PROBABILITY_HEADROOM - 1e-9;
}

/** `clamp(|delta| * 5, 0.05, 0.95)` — #504 decision 3, verbatim */
function confidenceOfDelta(delta: number): number {
  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, Math.abs(delta) * CONFIDENCE_SCALE));
}

/** Why one curated row produced nothing this refresh. `undefined` means it passed. */
type Refusal = string | undefined;

/** The book-quality half of the fail-closed guard */
function refuseOnBook(market: PolymarketMarket, now: Date): Refusal {
  if (market.closed) return 'the market is closed';
  if (market.updatedAt === undefined) return 'the market carries no updatedAt stamp';
  if (now.getTime() - market.updatedAt.getTime() > MAX_UPDATED_AGE_MS) {
    return `the market's updatedAt is ${market.updatedAt.toISOString()}, past the staleness bound`;
  }
  if (market.bestBid === undefined || market.bestAsk === undefined) {
    return 'the market has no live bid/ask';
  }
  const spread = market.spread ?? market.bestAsk - market.bestBid;
  if (spread > MAX_SPREAD) return `the spread is ${spread}, past ${MAX_SPREAD}`;
  if (market.volume24hr === undefined || market.volume24hr < MIN_VOLUME_24H_USD) {
    return `24h volume is ${market.volume24hr ?? 'absent'}, below ${MIN_VOLUME_24H_USD}`;
  }
  if (market.liquidity === undefined || market.liquidity < MIN_LIQUIDITY_USD) {
    return `liquidity is ${market.liquidity ?? 'absent'}, below ${MIN_LIQUIDITY_USD}`;
  }
  return undefined;
}

/** The two endpoints of the delta, or a refusal naming what the series could not support */
function endpointsOf(
  history: readonly PolymarketPricePoint[],
  now: Date,
): { baseline: PolymarketPricePoint; latest: PolymarketPricePoint } | string {
  if (history.length < 2) return 'the price history has fewer than two points';
  const ordered = [...history].sort((left, right) => left.at.getTime() - right.at.getTime());
  const latest = ordered[ordered.length - 1] as PolymarketPricePoint;
  if (now.getTime() - latest.at.getTime() > MAX_LATEST_POINT_AGE_MS) {
    return `the newest history point is ${latest.at.toISOString()}, past the staleness bound`;
  }
  const target = now.getTime() - DELTA_WINDOW_MS;
  let baseline = ordered[0] as PolymarketPricePoint;
  for (const point of ordered) {
    if (Math.abs(point.at.getTime() - target) < Math.abs(baseline.at.getTime() - target)) {
      baseline = point;
    }
  }
  if (Math.abs(baseline.at.getTime() - target) > BASELINE_TOLERANCE_MS) {
    return (
      'the price history does not span 24h — its oldest usable point is ' +
      `${baseline.at.toISOString()}, and a large move over a short series would land as a ` +
      'high-confidence signal built on almost no data'
    );
  }
  return { baseline, latest };
}

/**
 * `refused` counts as an answer (book thin, slug rotted, series short) and
 * marks the bucket. `transport-failed` does not: Gamma and the CLOB are
 * independent endpoints, so either one failing must leave the bucket
 * unmarked for a retry, not get credited via the other's success.
 */
type BuiltRow =
  | { outcome: 'item'; item: IntelligenceItem; raw: RawArchiveRow }
  | { outcome: 'refused' }
  | { outcome: 'transport-failed' };

/**
 * Keys off the RAW row rather than re-deriving: `PRAGMA foreign_keys` is off,
 * so a key that drifted from `raw` would silently orphan the item instead of
 * throwing
 */
export function toArchivedItem(item: IntelligenceItem, raw: RawArchiveRow): ArchivedItem {
  return {
    source: raw.source,
    native_id: raw.native_id,
    updated_at: raw.updated_at,
    entity: item.entity,
    asset_class: POLYMARKET_ASSET_CLASS,
    item,
    ingested_at: raw.ingested_at,
  };
}

export class PolymarketAgent {
  #bucket: number | undefined;
  #current: Promise<boolean> | undefined;
  /** In-memory only — see `#nextRefusalStreak` for how the archive backs a restart */
  readonly #refusals = new Map<string, number>();
  readonly #deps: PolymarketAgentDeps;
  readonly #refreshMs: number;
  readonly #table: readonly CuratedMacroMarket[];

  constructor(deps: PolymarketAgentDeps) {
    this.#deps = deps;
    this.#refreshMs = deps.refreshMs ?? POLYMARKET_REFRESH_MS;
    this.#table = deps.table ?? CURATED_MACRO_MARKETS;
  }

  /** Absorbs a throw from the logger: called as `void refresh(...)`, so a throwing logger would be an unhandled rejection */
  #log(entry: LogEntry): void {
    const logger = this.#deps.logger;
    if (logger !== undefined) safeLog(logger, entry);
  }

  #logFailure(template: LogEntryTemplate, error: unknown, payload: Record<string, unknown>): void {
    const logger = this.#deps.logger;
    if (logger !== undefined) logCaughtFailure(logger, template, error, payload);
  }

  /** Never throws — a vendor outage must degrade to `NO_DATA_MARKER`, not take down a run */
  async refresh(trace_id = 'polymarket'): Promise<boolean> {
    if (this.#current !== undefined) return false;
    const run = this.#pass(trace_id).catch((error: unknown) => {
      this.#logFailure(
        {
          trace_id,
          stage: 'market_intelligence',
          event: 'polymarket_pass_failed',
          level: 'warn',
          message:
            'market intelligence: the Polymarket pass failed outside the per-market paths; ' +
            'no macro items ingested this refresh. Not fatal — the analysts report NO DATA ' +
            'rather than a fabricated neutral view.',
        },
        error,
        { source: SOURCE_POLYMARKET },
      );
      return false;
    });
    this.#current = run;
    try {
      return await run;
    } finally {
      this.#current = undefined;
    }
  }

  /** Resolves when no pass is in flight. Never rejects. */
  async whenIdle(): Promise<void> {
    await this.#current?.catch(() => undefined);
  }

  async #pass(trace_id: string): Promise<boolean> {
    const now = this.#deps.clock.now();
    const bucketAt = floorToPolymarketBucket(now, this.#refreshMs);
    if (this.#bucket === bucketAt.getTime()) return false;

    const items: IntelligenceItem[] = [];
    const raws: RawArchiveRow[] = [];
    const archivedItems: ArchivedItem[] = [];
    /** How many rows produced a usable ANSWER — read, refused, or rotted alike */
    let answered = 0;

    for (const entry of this.#table) {
      let market: PolymarketMarket | undefined;
      try {
        market = await this.#deps.client.fetchEventMarket(entry.eventSlug, entry.marketSlug);
      } catch (error) {
        // Transient: does not count as answered, so the bucket stays unmarked and the next tick retries
        this.#logFailure(
          {
            trace_id,
            stage: 'market_intelligence',
            event: 'polymarket_market_fetch_failed',
            level: 'warn',
            message:
              `polymarket: fetching '${entry.id}' failed; it contributes nothing this refresh. ` +
              'The bucket is not marked, so the next pass retries.',
          },
          error,
          { source: SOURCE_POLYMARKET, curated_id: entry.id },
        );
        continue;
      }

      if (market === undefined) {
        // Slug rot: warn, not info, so the dead row gets re-pointed rather than silently zero-ingesting
        this.#log({
          trace_id,
          stage: 'market_intelligence',
          event: 'polymarket_curated_row_rotted',
          level: 'warn',
          message:
            `polymarket: curated row '${entry.id}' resolves to no open market ` +
            `(event '${entry.eventSlug}', market '${entry.marketSlug}'). Polymarket mints a ` +
            'NEW slug when an event resolves, so this row has almost certainly rotted and ' +
            'needs re-pointing in curated-markets.ts. Ingesting nothing for it.',
          payload: {
            source: SOURCE_POLYMARKET,
            curated_id: entry.id,
            event_slug: entry.eventSlug,
            market_slug: entry.marketSlug,
          },
        });
        // Gamma answered ("no such market"): durable state, not an outage, so re-asking would only repeat it
        answered += 1;
        continue;
      }

      const built = await this.#buildItem(trace_id, entry, market, now, bucketAt);
      if (built.outcome === 'transport-failed') continue;
      answered += 1;
      if (built.outcome === 'refused') continue;
      items.push(built.item);
      raws.push(built.raw);
      archivedItems.push(toArchivedItem(built.item, built.raw));
    }

    if (items.length === 0) {
      // Marked only when something answered — an all-transport-failure pass is a vendor outage, not a real answer
      if (answered > 0) this.#bucket = bucketAt.getTime();
      return false;
    }

    try {
      // Items are archived but `HYDRATING_MI_SOURCES` excludes this source from the boot read —
      // replaying a trailing-window statistic as current would compound the time-axis inflation limitation
      this.#deps.archive?.write(raws, archivedItems);
      this.#deps.store.ingest({
        agent_id: SOURCE_POLYMARKET,
        timestamp: now,
        asset_class: POLYMARKET_ASSET_CLASS,
        items,
      });
    } catch (error) {
      this.#logFailure(
        {
          trace_id,
          stage: 'market_intelligence',
          event: 'polymarket_store_write_failed',
          level: 'warn',
          message:
            'market intelligence: the Polymarket store/archive write failed; nothing ingested ' +
            'this refresh. The bucket is not marked, so the next pass retries.',
        },
        error,
        { source: SOURCE_POLYMARKET, items: items.length },
      );
      return false;
    }

    this.#bucket = bucketAt.getTime();
    this.#log({
      trace_id,
      stage: 'market_intelligence',
      level: 'info',
      message: 'market intelligence: ingested Polymarket macro items',
      payload: {
        source: SOURCE_POLYMARKET,
        asset_class: POLYMARKET_ASSET_CLASS,
        tracked: this.#table.length,
        items: items.length,
        bucket: bucketAt.toISOString(),
      },
    });
    return true;
  }

  /** One curated row → an item, a logged refusal, or a transport failure */
  async #buildItem(
    trace_id: string,
    entry: CuratedMacroMarket,
    market: PolymarketMarket,
    now: Date,
    bucketAt: Date,
  ): Promise<BuiltRow> {
    const refusal = refuseOnBook(market, now);
    if (refusal !== undefined) return this.#refuse(trace_id, entry, refusal, now);

    const outcomeIndex = market.outcomes.indexOf(entry.bullishOutcome);
    if (outcomeIndex < 0) {
      return this.#refuse(
        trace_id,
        entry,
        `the curated bullish outcome '${entry.bullishOutcome}' is not among the market's ` +
          `outcomes [${market.outcomes.join(', ')}] — the market's shape changed under the table`,
        now,
      );
    }
    const tokenId = market.tokenIds[outcomeIndex];
    if (tokenId === undefined) {
      return this.#refuse(trace_id, entry, 'the bullish outcome has no CLOB token id', now);
    }

    // Above the price-history fetch on purpose: a pinned row can never signal, so the CLOB call would be wasted
    const probability = market.outcomePrices[outcomeIndex];
    if (probability === undefined || !Number.isFinite(probability)) {
      return this.#refuse(
        trace_id,
        entry,
        'the bullish outcome carries no quoted probability',
        now,
      );
    }
    if (isPinnedProbability(probability)) {
      return this.#refuse(
        trace_id,
        entry,
        `the bullish outcome is quoted at ${probability}, leaving ` +
          `${Math.min(probability, 1 - probability).toFixed(4)} of headroom against the ` +
          `${MIN_PROBABILITY_HEADROOM} minimum — a contract pinned this near certainty cannot ` +
          'carry a 24h delta, so it would emit a zero vote every hour rather than a signal. ' +
          'Re-point this row at a bucket with room to move, or drop it, in curated-markets.ts',
        now,
      );
    }

    let history: PolymarketPricePoint[];
    try {
      history = await this.#deps.client.fetchPriceHistory(tokenId);
    } catch (error) {
      this.#logFailure(
        {
          trace_id,
          stage: 'market_intelligence',
          event: 'polymarket_price_history_failed',
          level: 'warn',
          message:
            `polymarket: price history for '${entry.id}' failed; it contributes nothing this ` +
            'refresh. The 24h delta is the signal, so a level without a baseline is not ' +
            'ingested at all. The CLOB is a separate endpoint from Gamma, so this counts as ' +
            'NO answer: the bucket is not marked and the next pass retries.',
        },
        error,
        { source: SOURCE_POLYMARKET, curated_id: entry.id },
      );
      return { outcome: 'transport-failed' };
    }

    const endpoints = endpointsOf(history, now);
    if (typeof endpoints === 'string') return this.#refuse(trace_id, entry, endpoints, now);

    const { baseline, latest } = endpoints;
    const delta = latest.probability - baseline.probability;
    const item: IntelligenceItem = {
      id: `${SOURCE_POLYMARKET}:${entry.id}:${bucketAt.toISOString()}`,
      source: SOURCE_POLYMARKET,
      type: 'news',
      // `now`, the ingest instant — never `bucketAt`. Stamping the bucket would backdate the item
      // into an already-open bar, which can buy a second paid debate on that bar. `id`/`native_id`
      // stay keyed to `bucketAt` instead, since those are the replay/dedup coordinates
      timestamp: now,
      entity: entry.entity,
      // Series name, not a ticker — without `scope: 'asset_class'` the entity filter drops the item
      // for every content-reading analyst
      scope: 'asset_class',
      headline:
        `${entry.label}: ${baseline.probability.toFixed(3)} -> ` +
        `${latest.probability.toFixed(3)} over 24h ` +
        `(delta ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}, ` +
        `$${Math.round(market.volume24hr ?? 0).toLocaleString('en-US')} 24h volume)`,
      sentiment: signOfDelta(delta),
      confidence: confidenceOfDelta(delta),
      summary: `${market.question} — bullish outcome '${entry.bullishOutcome}'. ${entry.rationale}`,
      url: `https://polymarket.com/event/${entry.eventSlug}`,
    };

    const raw: RawArchiveRow = {
      source: SOURCE_POLYMARKET,
      native_id: `${entry.id}:${bucketAt.toISOString()}`,
      // The vendor's revision stamp, not ours — `ingested_at` is the visibility gate
      updated_at: market.updatedAt ?? bucketAt,
      payload: JSON.stringify({
        market: market.payload,
        baseline: { at: baseline.at.toISOString(), p: baseline.probability },
        latest: { at: latest.at.toISOString(), p: latest.probability },
      }),
      ingested_at: now,
      fidelity: 'live',
    };

    this.#refusals.delete(entry.id);
    this.#deps.archive?.clearRefusalStreak(SOURCE_POLYMARKET, entry.id);
    return { outcome: 'item', item, raw };
  }

  #refuse(trace_id: string, entry: CuratedMacroMarket, reason: string, now: Date): BuiltRow {
    const streak = this.#nextRefusalStreak(entry.id);
    this.#refusals.set(entry.id, streak);
    this.#deps.archive?.recordRefusalStreak(SOURCE_POLYMARKET, entry.id, streak, reason, now);
    // One refusal is routine; a full day of consecutive refusals means the row is dead, not quiet
    const persistent = streak >= REFUSAL_WARN_STREAK;
    this.#log({
      trace_id,
      stage: 'market_intelligence',
      event: 'polymarket_row_refused',
      level: persistent ? 'warn' : 'info',
      message: persistent
        ? `polymarket: curated row '${entry.id}' has been refused ${streak} passes in a row — ` +
          `latest reason: ${reason}. A permanently-refused row contributes nothing and needs ` +
          'either re-pointing or removing in curated-markets.ts. Ingesting nothing for it.'
        : `polymarket: refusing '${entry.id}' — ${reason}. Ingesting nothing rather than a ` +
          'neutral item, so the analysts report NO DATA and "could not look" stays ' +
          'distinguishable from "looked and saw nothing".',
      payload: { source: SOURCE_POLYMARKET, curated_id: entry.id, consecutive_refusals: streak },
    });
    return { outcome: 'refused' };
  }

  /** Falls back to the archive's persisted streak on this process's first miss, so a restart resumes the escalation instead of restarting at 1 */
  #nextRefusalStreak(id: string): number {
    const inMemory = this.#refusals.get(id);
    if (inMemory !== undefined) return inMemory + 1;
    return (this.#deps.archive?.refusalStreak(SOURCE_POLYMARKET, id) ?? 0) + 1;
  }
}
