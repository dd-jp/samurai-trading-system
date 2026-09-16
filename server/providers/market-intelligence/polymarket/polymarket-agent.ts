/**
 * The Polymarket macro/event ingestion agent.
 *
 * ## Why a second source feeding `fundamental`
 *
 * `MiIngestAgent` (Alpaca/Benzinga) already writes `news`; this agent's items
 * route to `intel` instead, and `fundamental-analyst.ts` folds the two
 * together. It exists because `news` has a measured coverage hole: Alpaca
 * News returns 0 items for the live LSE-ETP universe (ADR-0016). A 3x FTSE
 * ETP has no company news; what moves it is macro.
 *
 * ## Why macro markets and not the price ladders
 *
 * A short-dated binary on an asset's own price is a deterministic function
 * of that asset's spot and short-dated vol — arbitrageurs price it off spot,
 * so it carries no independent information `technical-analyst` doesn't
 * already have, and ingesting it would double-count price while looking
 * like a second opinion. `P(Fed holds in September)` is not derivable from
 * any bar we hold.
 *
 * ## The signal is the 24h change, never the level
 *
 * A probability parked at 0.295 for a week is not news; 0.295 → 0.44 in a
 * day is. So `sentiment = sign(delta)` with a `DEAD_BAND`, and
 * `confidence = clamp(|delta| * 5, 0.05, 0.95)`.
 *
 * ## Fail-closed, with one deliberate exception
 *
 * No ingest on a rotted slug, a failed fetch, a closed market, a stale
 * vendor stamp, a thin book, a pinned probability (`MIN_PROBABILITY_HEADROOM`),
 * or a price history that does not span a full 24h — the analysts report
 * `NO_DATA_MARKER`, keeping "could not look" distinguishable from "looked
 * and saw nothing". The exception: a delta inside the dead band still emits
 * an item at `sentiment: 0, confidence: 0.05` — "looked and it did not move"
 * is real information, not the same claim as "could not look".
 *
 * ## The history-span guard is the one worth not deleting
 *
 * `confidence = f(|delta|)`, so a market minted three hours ago that moved
 * 0.30 in that window would land as a high-confidence signal built on
 * almost no data. The baseline point must sit within `BASELINE_TOLERANCE_MS`
 * of exactly 24h ago or nothing is emitted.
 *
 * ## Three known limitations, none fixed here
 *
 * 1. **Does not close the LSE-ETP coverage hole.** `hasCoverageFor` matches
 *    `item.entity === instrument`, but these items are filed under macro
 *    series names, never tickers.
 * 2. **One direction for a whole asset class.** Items are `scope:
 *    'asset_class'`, reaching every `stocks` debate even where a factor is
 *    bullish for one instrument and bearish for another — `IntelligenceItem`
 *    has no per-instrument direction to express that.
 * 3. **Time-axis vote inflation, bounded but not by design.** The store does
 *    no dedup by `id`, so an hourly cadence ingests up to 24 items per
 *    curated row into the 24h window; `latestClassWideRestatementOnly`
 *    (`index.ts`) collapses the repeats on read. This is uniform within this
 *    source but not against Alpaca's non-replayed `news` items — harmless
 *    only because Alpaca contributes 0 on the live LSE-ETP universe. The fix
 *    belongs in `MarketIntelligenceStore.ingest`, not here.
 *
 * ## No spend plumbing, and no Convergence Engine
 *
 * No `spendCap`/`spendSink`: this path makes no LLM call and costs £0.
 * `grok` writes `social` and this writes `intel` — disjoint buckets read by
 * different analysts, so there was never anything to converge.
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

/**
 * The one asset class these items are ingested under. One batch, not two —
 * crypto left Samurai's scope, so a second batch would be ingested for
 * debates that never run.
 */
export const POLYMARKET_ASSET_CLASS: AssetClass = 'stocks';

/**
 * The refresh interval, and the bucket the cache keys on. One hour = 1/24th
 * of the analysts' 24h context window — derived from staleness, not cost,
 * since this path is free. It also happens to equal
 * `DEBATE_BAR_TIMEFRAME_MS`, which bounds visibility latency to at most one
 * refresh's worth rather than removing it, since `getContext` floors its
 * window end to the bar.
 */
const POLYMARKET_REFRESH_MS = 60 * 60 * 1000;

/** Below this |delta| the market did not move enough to call a direction */
const DEAD_BAND = 0.02;

/** `|delta| * 5` saturates the 0.95 ceiling at a 0.19 move */
const CONFIDENCE_SCALE = 5;
const MIN_CONFIDENCE = 0.05;
const MAX_CONFIDENCE = 0.95;

/**
 * The headroom `min(p, 1 - p)` a tracked outcome must have to be a signal
 * source at all. A contract pinned near 0 or 1 cannot arithmetically carry a
 * `DEAD_BAND`-sized delta, so it would emit `sentiment: 0, confidence: 0.05`
 * every hour forever — not a neutral observation but a permanent zero vote
 * that dilutes `directionFrom`'s unweighted mean against every row that did
 * move. A refused row casts no vote at all.
 *
 * 0.10 is derived from the confidence formula: requiring a row to express at
 * least mid-range confidence in both directions gives
 * `((MIN_CONFIDENCE + MAX_CONFIDENCE) / 2) / CONFIDENCE_SCALE`. This is a
 * runtime guard, not a build-time table filter, because `p` is a live quote
 * that can drift into the pin after curation.
 */
const MIN_PROBABILITY_HEADROOM = 0.1;

/** Book-quality floors: a probability read off a book this wide is not a price, it is a guess with a bid/ask around it */
const MAX_SPREAD = 0.05;
const MIN_VOLUME_24H_USD = 100;
const MIN_LIQUIDITY_USD = 5_000;

/** How stale the vendor's own revision stamp may be — far past anything healthy, fires only on a market that has genuinely stopped updating */
const MAX_UPDATED_AGE_MS = 6 * 60 * 60 * 1000;

/** The delta's lookback. Matches the analysts' context window by construction. */
const DELTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How far the baseline point may sit from exactly 24h ago. Two hours at hourly
 * fidelity is two points of slack — enough to absorb a gap in a quiet series,
 * far too little to let a three-hour-old market pass as a 24h delta.
 */
const BASELINE_TOLERANCE_MS = 2 * 60 * 60 * 1000;

/**
 * How many consecutive refusals a curated row may accumulate before its
 * refusal log escalates from `info` to `warn`. 24 = a full day at the hourly
 * refresh cadence.
 */
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
  /**
   * The MI archive, when this run has one. Both the raw bytes and the
   * derived items are written; also where each curated row's
   * consecutive-refusal streak is persisted, so a restart resumes an
   * escalation instead of restarting it at 1 (see `#nextRefusalStreak`).
   */
  archive?: MiArchiveStore | undefined;
  logger?: Logger | undefined;
  /** Overridable for tests; defaults to the reviewed table */
  table?: readonly CuratedMacroMarket[];
  /** Overridable for tests; defaults to the derived 1h */
  refreshMs?: number;
}

/**
 * Floors an instant to its refresh bucket. Epoch-relative, matching
 * `floorToBar`'s rule (#393) and `floorToRefreshBucket`'s, so a replay
 * stepping the same grid lands on the same coordinate.
 */
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
  // The tolerance is not decoration: `1 - 0.9` is 0.09999999999999998 in
  // binary floating point, so a bare `<` would refuse a market quoted at
  // exactly the bound. Vendor quotes arrive at two or three decimals, so a
  // 1e-9 slack cannot admit anything a reviewer would call pinned
  return Math.min(probability, 1 - probability) < MIN_PROBABILITY_HEADROOM - 1e-9;
}

/** `clamp(|delta| * 5, 0.05, 0.95)` — #504 decision 3, verbatim */
function confidenceOfDelta(delta: number): number {
  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, Math.abs(delta) * CONFIDENCE_SCALE));
}

/** Why one curated row produced nothing this refresh. `undefined` means it passed. */
type Refusal = string | undefined;

/** The book-quality half of the fail-closed guard */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a flat sequence of independent fail-closed gates, each naming the one condition it refuses; splitting them apart would obscure that every gate is a peer of every other, not a nested decision.
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
 * What one curated row produced this pass, and whether it answered.
 * `refused` is an answer (vendor reachable, book thin, slug rotted, series
 * too short) so the bucket is marked. `transport-failed` is not, and is kept
 * distinct: Gamma and the CLOB are independent endpoints, so a pass can read
 * every market from Gamma yet reach no price history — that must leave the
 * bucket unmarked so the next pass retries, same as a Gamma-side throw.
 */
type BuiltRow =
  | { outcome: 'item'; item: IntelligenceItem; raw: RawArchiveRow }
  | { outcome: 'refused' }
  | { outcome: 'transport-failed' };

/**
 * Keys the archive row off the RAW row rather than re-deriving the key.
 * `mi_items` declares `(source, native_id, updated_at)` as a foreign key into
 * `mi_archive_raw` with `PRAGMA foreign_keys` off, so a drifted key would
 * silently orphan the item instead of throwing. Exported so the drift is
 * testable — `itemsKnownAt`'s own read never selects the key columns.
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
  /** The bucket already fetched. In-memory: a restart refetches, which is correct. */
  #bucket: number | undefined;
  #current: Promise<boolean> | undefined;
  /**
   * Consecutive book-quality refusals per curated row — see `#refuse`.
   * In-memory only; resets on restart. `#nextRefusalStreak` reads the
   * archive on this map's first miss for a row so a restart continues an
   * escalation the archive was already tracking rather than restarting it at 1.
   */
  readonly #refusals = new Map<string, number>();
  readonly #deps: PolymarketAgentDeps;
  readonly #refreshMs: number;
  readonly #table: readonly CuratedMacroMarket[];

  constructor(deps: PolymarketAgentDeps) {
    this.#deps = deps;
    this.#refreshMs = deps.refreshMs ?? POLYMARKET_REFRESH_MS;
    this.#table = deps.table ?? CURATED_MACRO_MARKETS;
  }

  /**
   * Absorbs a throw from the logger itself: called as `void refresh(...)`
   * from `production.ts`'s timer, so a throwing logger would surface as an
   * unhandled rejection, and the process's fault handler exits on those
   */
  #log(entry: LogEntry): void {
    const logger = this.#deps.logger;
    if (logger !== undefined) safeLog(logger, entry);
  }

  #logFailure(template: LogEntryTemplate, error: unknown, payload: Record<string, unknown>): void {
    const logger = this.#deps.logger;
    if (logger !== undefined) logCaughtFailure(logger, template, error, payload);
  }

  /**
   * One refresh of the whole curated table, if its bucket has rolled over.
   * **Never throws** — a vendor outage must degrade the desk to
   * `NO_DATA_MARKER` rather than take down a run. A call made while a pass
   * is in flight returns `false` rather than starting a second one.
   */
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

  /**
   * One curated row's contribution to a pass: whether it ANSWERED (read,
   * refused, or rotted alike — everything but a transport failure) and, when
   * it produced a usable signal, the item and its raw archive row
   */
  async #processEntry(
    trace_id: string,
    entry: CuratedMacroMarket,
    now: Date,
    bucketAt: Date,
  ): Promise<{ answered: boolean; item?: IntelligenceItem; raw?: RawArchiveRow }> {
    let market: PolymarketMarket | undefined;
    try {
      market = await this.#deps.client.fetchEventMarket(entry.eventSlug, entry.marketSlug);
    } catch (error) {
      // Transient, so it does not count as answered; bucket stays unmarked
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
      return { answered: false };
    }

    if (market === undefined) {
      // A decayed table degrades to silent zero-ingest — the mute-analyst
      // state this source exists to relieve — so this warns naming the row
      // to edit rather than logging at info
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
      // A decayed table is a durable state, not an outage, so it counts as answered
      return { answered: true };
    }

    const built = await this.#buildItem(trace_id, entry, market, now, bucketAt);
    if (built.outcome === 'transport-failed') return { answered: false };
    if (built.outcome === 'refused') return { answered: true };
    return { answered: true, item: built.item, raw: built.raw };
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
      const outcome = await this.#processEntry(trace_id, entry, now, bucketAt);
      if (outcome.answered) answered += 1;
      if (outcome.item !== undefined && outcome.raw !== undefined) {
        items.push(outcome.item);
        raws.push(outcome.raw);
        archivedItems.push(toArchivedItem(outcome.item, outcome.raw));
      }
    }

    if (items.length === 0) {
      // Marked only when something answered: all-transport-failed (see
      // `BuiltRow`) is a vendor outage to retry, not a real answer to cache
      if (answered > 0) this.#bucket = bucketAt.getTime();
      return false;
    }

    try {
      // Archives both raw bytes and derived items so a restart can hydrate
      // without re-serving a trailing-window statistic as current: this
      // source is excluded from `HYDRATING_MI_SOURCES`'s boot read, so
      // hydration comes only from the archive, not from `store.ingest` below
      this.#deps.archive?.write(raws, archivedItems);
      this.#deps.store.ingest({
        agent_id: SOURCE_POLYMARKET,
        // `MarketIntelligenceStore.ingest` carries this but filters on the
        // item timestamp instead — set equal so the two cannot disagree
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

    // Checked above the price-history fetch: a pinned row can never produce a
    // signal, so the CLOB call would be wasted. Routed through `#refuse` so it
    // still counts as answered — a pinned contract is a durable state, not an outage
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
      // Stable per (row, bucket): a replay stepping the same grid rebuilds the
      // same id, and the archive's natural key absorbs a repeated write
      id: `${SOURCE_POLYMARKET}:${entry.id}:${bucketAt.toISOString()}`,
      source: SOURCE_POLYMARKET,
      type: 'news',
      // `now`, the ingest instant — never `bucketAt`. Stamping the bucket would
      // backdate the item into an already-open bar, letting a mid-bar count
      // change and buy a second debate on a bar that already had one. `id`
      // and `native_id` stay keyed to `bucketAt` since those are replay/dedup
      // coordinates and must be stable across a replay of the same grid
      timestamp: now,
      entity: entry.entity,
      // A curated macro market is evidence for the whole class, not one
      // instrument: `entry.entity` is a series name (`FOMC-2026-09`), never a
      // ticker, so without this scope it would be dropped by every
      // entity-scoped caller's filter
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

    // The row answered, so its refusal streak resets rather than escalating
    this.#refusals.delete(entry.id);
    this.#deps.archive?.clearRefusalStreak(SOURCE_POLYMARKET, entry.id);
    return { outcome: 'item', item, raw };
  }

  #refuse(trace_id: string, entry: CuratedMacroMarket, reason: string, now: Date): BuiltRow {
    const streak = this.#nextRefusalStreak(entry.id);
    this.#refusals.set(entry.id, streak);
    this.#deps.archive?.recordRefusalStreak(SOURCE_POLYMARKET, entry.id, streak, reason, now);
    // One refusal is routine (a quiet hour on a market that trades around a
    // print) and stays `info`; past a full day of consecutive refusals the
    // row is functionally dead and must reach the same eyes slug rot does
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

  /**
   * The next streak value for `id`. On this process's first refusal for `id`
   * it falls back to the archive's persisted count rather than 0, so an
   * escalation resumes across a restart instead of restarting at 1.
   */
  #nextRefusalStreak(id: string): number {
    const inMemory = this.#refusals.get(id);
    if (inMemory !== undefined) return inMemory + 1;
    return (this.#deps.archive?.refusalStreak(SOURCE_POLYMARKET, id) ?? 0) + 1;
  }
}
