/**
 * The Polymarket macro/event ingestion agent (#504, decisions from wayfinder
 * research #481 and `docs/research/23-polymarket-source.md`).
 *
 * ## Why a SECOND news source
 *
 * The `news` bucket already has a writer — `MiIngestAgent` (`type: 'news'`,
 * the Alpaca/Benzinga wire). This is not the first one and does not exist to
 * fill an empty bucket. It exists because that writer's coverage has a
 * measured hole: **Alpaca News returns 0 items for 3USL / 3LDE / SGLN**
 * against 5 each for AAPL/SPY/BTCUSD (#552, quoted in
 * `docs/specs/market-intelligence-spec.md`). The live universe is exactly
 * those LSE ETPs (ADR-0016), so `fundamental` — mandatory for stocks — has a
 * writer that returns nothing for every instrument Samurai can actually
 * trade. A 3x FTSE ETP has no company news; what moves it is macro.
 *
 * ## Why macro markets and NOT the price ladders
 *
 * A short-dated binary on an asset's own price is a deterministic function of
 * that asset's spot and short-dated vol. Arbitrageurs price it OFF spot, so it
 * carries no independent information about spot — and `technical-analyst`
 * already reads the same bars. The Debate Engine sizes trades on apparent
 * analyst agreement, so ingesting a price ladder would double-count price
 * while looking like a second opinion. `P(Fed holds in September)` is not
 * derivable from any bar we hold; that is the whole adopt case.
 *
 * ## The signal is the 24h CHANGE, never the level
 *
 * A Fed-hike probability parked at 0.295 for a week is not news; 0.295 → 0.44
 * in a day is. So `sentiment = sign(delta)` with a ±0.02 dead band and
 * `confidence = clamp(|delta| * 5, 0.05, 0.95)`, measured on the token of the
 * outcome the curated table annotates as bullish for equities.
 *
 * ## Fail-closed, with one deliberate exception
 *
 * No ingest on: a rotted slug, a failed fetch, a closed market, a stale vendor
 * stamp, an absent book, a spread past the bound, volume or liquidity below
 * the floor, a bullish leg pinned so near 0 or 1 that it cannot carry a 24h
 * delta (`MIN_PROBABILITY_HEADROOM`, #833), or a price history that does not
 * span a full 24h. In every one of those cases the analysts report
 * `NO_DATA_MARKER`, which keeps "we could not look" distinguishable from "we
 * looked and saw nothing" — the #463/#474/#485 line.
 *
 * The **exception, stated because it looks like a violation of that rule**: a
 * delta inside the dead band DOES emit an item, at `sentiment: 0,
 * confidence: 0.05`. #504's decision 7 bans synthesising a neutral item for
 * the five could-not-look cases it enumerates; it does not ban reporting a
 * market we successfully read that genuinely did not move. Decision 3's
 * `clamp(|delta|*5, 0.05, 0.95)` floor only has meaning if delta≈0 produces
 * an item at all. "We looked and it did not move" is real information and is
 * not the same claim as "we could not look".
 *
 * ## The history-span guard is the one worth not deleting
 *
 * `confidence = f(|delta|)`, so a market minted three hours ago that moved
 * 0.30 over those three hours would land as a HIGH-confidence signal built on
 * almost no data — verbatim the defect `gdelt-ingest-agent.ts`'s header
 * refuses to ship, in the same shape. The baseline point must sit within
 * `BASELINE_TOLERANCE_MS` of exactly 24h ago or nothing is emitted.
 *
 * ## Three known limitations, none of them fixed here
 *
 * **1. This does NOT close the LSE-ETP coverage hole.** `hasCoverageFor`
 * (`production/mi-coverage.ts`) matches `item.entity === instrument`, and
 * these items are filed under macro series names (`FOMC-2026-09`), never
 * tickers. `MiCoverageMonitor.degraded` will read exactly as it does today.
 * Setting `entity` to a ticker would light the counter up without the item
 * saying anything about that ticker — gaming the metric, and it would break
 * one-item-per-event too.
 *
 * **2. One direction for a whole asset class.** These items are `scope:
 * 'asset_class'`, so every one reaches every `stocks` debate — including
 * SGLN, where a rising recession probability is plausibly BULLISH while it is
 * bearish for 3USL. `IntelligenceItem` has no per-instrument direction to
 * express that with. (Before #1086 this read "`getContext` filters by
 * `asset_class` alone", which #914's entity narrowing had already made false:
 * the items were reaching no content-reading analyst at all.)
 *
 * **3. Time-axis vote inflation — now bounded, not by design.**
 * `MarketIntelligenceStore.ingest` does no dedup by `id` and `directionFrom`
 * is an unweighted mean of signs, so at an hourly cadence one curated row
 * ingests up to 24 items into the analysts' 24h window. What holds the vote
 * to one is `latestClassWideRestatementOnly` (`index.ts`), which keys
 * class-wide items on `(source, entity, type)` and serves only the latest —
 * so the read collapses the repeats even though the store keeps them.
 * Narrowing `scope` here would restore the inflation.
 *
 * Archiving the items (#835) does not change this, and does not make replay
 * of this source clean: a replay reading `mi_items` back replays the same
 * hourly repetition, because the inflation is in what was ingested, not in
 * what was stored. What #835 fixed is that the rows exist to be read at all.
 *
 * It is uniform WITHIN this source, so it does not skew one curated row
 * against another. It is **not** uniform across the `news` bucket, and saying
 * so would be false: `directionFrom` averages over every item in the bucket,
 * and the other writer (`MiIngestAgent`, Alpaca/Benzinga) is not replayed
 * hourly. On a universe where Alpaca does return items — the ~5 each it
 * returns for AAPL/SPY (#552) — a handful of curated rows replayed hourly
 * reach ~72 items in the same 24h window, so the mean is roughly 14:1 this
 * source's, on DIRECTION as well as vote count, and on the confidence the
 * Debate Engine sizes against. It is only harmless on the live LSE-ETP
 * universe (ADR-0016), where Alpaca contributes 0 and there is nothing to
 * drown out. Recorded rather than solved here because the dedup belongs in
 * `MarketIntelligenceStore.ingest`, not in one source.
 *
 * ## No spend plumbing, and no Convergence Engine
 *
 * `GrokAgent`'s `spendCap`/`spendSink` are absent on purpose: this path makes
 * no LLM call and costs £0, and zero-cost rows in `llm_spend` would only make
 * ADR-0008's ledger harder to read. `MarketContext.conflicts` stays `[]` — a
 * stated v1 narrowing, as #464 did: `grok` writes `social` and this writes
 * `news`, disjoint buckets read by different analysts, so there is nothing to
 * converge.
 */

import type { AssetClass, Clock, LogEntry, Logger } from '../../../shared/index.js';
import { logCaughtFailure, safeLog } from '../../../shared/safe-log.js';
import type { ArchivedItem, MiArchiveStore, RawArchiveRow } from '../archive/mi-archive-store.js';
import { MI_SOURCES } from '../archive/mi-sources.js';
import type { MarketIntelligenceStore } from '../index.js';
import type { IntelligenceItem } from '../types.js';
import type { CuratedMacroMarket } from './curated-markets.js';
import { CURATED_MACRO_MARKETS } from './curated-markets.js';
import type { PolymarketMarket, PolymarketPricePoint } from './polymarket-client.js';

/** The `source` on every item and archive row this agent writes. */
export const SOURCE_POLYMARKET = MI_SOURCES.polymarket;

/**
 * The one asset class these items are ingested under.
 *
 * ONE batch, not two. #481's resolution said `crypto` + `stocks`, because
 * `getContext` filters by asset class alone and a macro item is relevant to
 * both. Crypto left Samurai's scope on 2026-08-16 (ADR-0015's amendment), so
 * the second batch would now be ingested for debates that never run. #504's
 * rewritten body strikes it; this follows the issue, not the older comment.
 */
export const POLYMARKET_ASSET_CLASS: AssetClass = 'stocks';

/**
 * The refresh interval, and the bucket the cache keys on.
 *
 * One hour = 1/24th of the analysts' 24h context window. DERIVED from
 * staleness, not from cost — unlike `GROK_REFRESH_MS`, which is a cost
 * fraction, because this path is free.
 *
 * It also happens to equal `DEBATE_BAR_TIMEFRAME_MS`, and that coincidence
 * bounds the visibility latency rather than removing it: items are stamped at
 * the ingest instant (see `#buildItem`) and `getContext` floors its window end
 * to the bar, so at most one refresh's worth of item waits for the next bar to
 * open. An earlier draft of this comment claimed the bucket floor made the
 * stamp land ON that bar — it did, and that was the #782 defect, not the fix.
 */
export const POLYMARKET_REFRESH_MS = 60 * 60 * 1000;

/** Below this |delta| the market did not move enough to call a direction. */
export const DEAD_BAND = 0.02;

/** `|delta| * 5` saturates the 0.95 ceiling at a 0.19 move. */
const CONFIDENCE_SCALE = 5;
const MIN_CONFIDENCE = 0.05;
const MAX_CONFIDENCE = 0.95;

/**
 * The headroom `min(p, 1 - p)` a tracked outcome must have to be a signal
 * source at all (#833).
 *
 * **Why any bound.** `sentiment = sign(delta)` with a ±`DEAD_BAND` dead band,
 * and a delta inside the band still EMITS — deliberately, #504 decision 7, and
 * that emit is not in question here. But a contract pinned at 0.9945 has
 * 0.0055 of room on the upside: it cannot carry a +0.02 delta arithmetically,
 * and a −0.02 delta is a repricing of a near-settled question rather than the
 * ordinary daily movement the delta is meant to read. So it emits
 * `sentiment: 0, confidence: 0.05` every hour, forever. That is not a neutral
 * observation, it is a permanent zero vote: `directionFrom`
 * (`pipeline/analysts/fundamental-analyst.ts`) takes an UNWEIGHTED mean of
 * sentiments and `confidenceFrom` an unweighted mean of confidences, so a
 * pinned row dilutes both means of every row that did move. A refused row
 * casts no vote at all — that asymmetry is the whole fix.
 *
 * **Why 0.10 and not some other number.** Derived from the confidence formula,
 * not from the two rows it happens to exclude: the smallest delta that says
 * anything is `DEAD_BAND`, and `|delta| * CONFIDENCE_SCALE` saturates at
 * `MAX_CONFIDENCE`. Requiring a row to be able to express at least MID-RANGE
 * confidence in BOTH directions gives
 * `((MIN_CONFIDENCE + MAX_CONFIDENCE) / 2) / CONFIDENCE_SCALE = 0.10`. Below
 * that, the constrained direction can only ever emit near the confidence floor
 * or nothing at all.
 *
 * The stricter alternative — full saturation headroom, 0.19 — was rejected on
 * margin, not on which rows it drops. Probed live on 2026-08-18, all six
 * curated rows: 0.715, 0.765, 0.755, 0.800, 0.925, 0.725. Both bounds exclude
 * exactly the same row (`us-recession-2026`, headroom 0.075), so the margin is
 * the only discriminator — and 0.19 leaves `fed-2027-01` (0.800) with 0.010 of
 * it and `fed-2026-10` (0.765) with 0.045, so ordinary drift on a healthy
 * series would evict it. At 0.10 those margins are 0.100 and 0.135.
 *
 * This is a RUNTIME guard and not the build-time table filter #833 proposed,
 * because `p` is a live quote — there is no curation-time value to test. The
 * guard applies to every curated row on every pass, so a row that drifts into
 * the pin later, or a future row added while pinned, is caught without anyone
 * remembering this rule.
 */
export const MIN_PROBABILITY_HEADROOM = 0.1;

/**
 * Book-quality floors. Markets measured at 0.298 (`U.K. Annual Inflation
 * 2026`) and 0.97 (`Bitcoin ETF Flows`) spreads are exactly what these refuse:
 * a probability read off a book that wide is not a price, it is a guess with a
 * bid/ask around it.
 */
const MAX_SPREAD = 0.05;
const MIN_VOLUME_24H_USD = 100;
const MIN_LIQUIDITY_USD = 5_000;

/**
 * How stale the vendor's own revision stamp may be. Measured stamps were under
 * 4 minutes old (#481 §5); 6 hours is far past anything healthy and only fires
 * on a market that has genuinely stopped updating.
 */
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

/** How stale the newest history point may be before the series is refused. */
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
   * The MI archive, when this run has one. Both the raw bytes and the derived
   * items are written (#835); `archive/mi-sources.ts` is what keeps the items
   * from being re-ingested at boot. Also where each curated row's consecutive-
   * refusal streak is persisted (#1120) — `#nextRefusalStreak` reads it back
   * so a restart resumes an escalation instead of restarting it at 1.
   */
  archive?: MiArchiveStore | undefined;
  logger?: Logger | undefined;
  /** Overridable for tests; defaults to the reviewed table. */
  table?: readonly CuratedMacroMarket[];
  /** Overridable for tests; defaults to the derived 1h. */
  refreshMs?: number;
}

/**
 * Floors an instant to its refresh bucket. Epoch-relative, matching
 * `floorToBar`'s rule (#393) and `floorToRefreshBucket`'s, so a replay
 * stepping the same grid lands on the same coordinate.
 */
export function floorToPolymarketBucket(at: Date, refreshMs: number = POLYMARKET_REFRESH_MS): Date {
  return new Date(Math.floor(at.getTime() / refreshMs) * refreshMs);
}

/** The three-valued sign the contract carries, with the dead band applied. */
export function signOfDelta(delta: number): 1 | 0 | -1 {
  if (delta > DEAD_BAND) return 1;
  if (delta < -DEAD_BAND) return -1;
  return 0;
}

/**
 * Whether a quoted probability sits too near 0 or 1 to carry a 24h delta.
 * See `MIN_PROBABILITY_HEADROOM` for the derivation of the bound.
 */
export function isPinnedProbability(probability: number): boolean {
  // The tolerance is not decoration: `1 - 0.9` is 0.09999999999999998 in
  // binary floating point, so a bare `<` would refuse a market quoted at
  // exactly the bound. Vendor quotes arrive at two or three decimals, so a
  // 1e-9 slack cannot admit anything a reviewer would call pinned.
  return Math.min(probability, 1 - probability) < MIN_PROBABILITY_HEADROOM - 1e-9;
}

/** `clamp(|delta| * 5, 0.05, 0.95)` — #504 decision 3, verbatim. */
export function confidenceOfDelta(delta: number): number {
  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, Math.abs(delta) * CONFIDENCE_SCALE));
}

/** Why one curated row produced nothing this refresh. `undefined` means it passed. */
type Refusal = string | undefined;

/** The book-quality half of the fail-closed guard. */
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

/** The two endpoints of the delta, or a refusal naming what the series could not support. */
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
 * What one curated row produced this pass, and — the part that matters —
 * whether it ANSWERED.
 *
 * `refused` is an answer: the vendor was reachable and the book was thin, the
 * slug rotted, or the series was too short. Re-asking inside the hour would
 * only repeat it, so the bucket is marked.
 *
 * `transport-failed` is not an answer, and it is a distinct case from `refused`
 * rather than a shade of it. Gamma and the CLOB are INDEPENDENT endpoints, so a
 * pass can read every market from Gamma and reach no price history at all; if
 * the Gamma read alone credited the row, that outage would mark the bucket and
 * suppress the retry for the rest of the hour. Whichever transport failed, the
 * answer is the same one the Gamma-side throw already gets: contribute nothing,
 * leave the bucket unmarked, let the next pass re-ask.
 */
type BuiltRow =
  | { outcome: 'item'; item: IntelligenceItem; raw: RawArchiveRow }
  | { outcome: 'refused' }
  | { outcome: 'transport-failed' };

/**
 * The archive row for one built item, keyed off the RAW row rather than
 * re-derived (#835).
 *
 * `mi_items` declares `(source, native_id, updated_at)` as a foreign key into
 * `mi_archive_raw`, and the store does not turn `PRAGMA foreign_keys` on — so a
 * key that drifted from its raw row would not throw, it would silently orphan
 * the item and break exactly the provenance `retrievalEvidence` now means
 * (#555). Reading the triple off `raw` makes drift impossible rather than
 * merely tested for.
 *
 * Exported so the drift itself is testable: a test that only reads back what
 * `itemsKnownAt` serves cannot see the key columns at all (that read selects
 * `asset_class, item_json` and nothing else), so it would stay green against a
 * drifted `native_id`.
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
   *
   * In-memory only; the archive (when present) is the durable copy (#1120)
   * that survives this map resetting on every restart. `#nextRefusalStreak`
   * reads the archive on this map's first miss for a row so the count picked
   * up here continues an escalation the archive was already tracking rather
   * than restarting it at 1.
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
   * Logs, absorbing a throw from the logger itself — the same contract, and
   * for the same reason, `GdeltIngestAgent.log` documents: this is called as
   * `void refresh(...)` from `production.ts`'s own timer, so a throwing logger
   * would surface as an unhandled rejection in a process meant to run
   * unattended for fourteen days, and #714's fault handler EXITS on those.
   */
  #log(entry: LogEntry): void {
    const logger = this.#deps.logger;
    if (logger !== undefined) safeLog(logger, entry);
  }

  #logFailure(
    template: Omit<LogEntry, 'payload'>,
    error: unknown,
    payload: Record<string, unknown>,
  ): void {
    const logger = this.#deps.logger;
    if (logger !== undefined) logCaughtFailure(logger, template, error, payload);
  }

  /**
   * One refresh of the whole curated table, if its bucket has rolled over.
   *
   * Returns whether anything was ingested. **Never throws** — market
   * intelligence is an optional input, so a vendor outage must degrade the
   * desk to `NO_DATA_MARKER` rather than take down a run.
   *
   * Concurrent calls do not stack: a call made while a pass is in flight
   * returns `false` rather than starting a second one.
   */
  async refresh(trace_id = 'polymarket'): Promise<boolean> {
    if (this.#current !== undefined) return false;
    const run = this.#pass(trace_id).catch((error: unknown) => {
      this.#logFailure(
        {
          trace_id,
          stage: 'market_intelligence',
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
    /** How many rows produced a usable ANSWER — read, refused, or rotted alike. */
    let answered = 0;

    for (const entry of this.#table) {
      let market: PolymarketMarket | undefined;
      try {
        market = await this.#deps.client.fetchEventMarket(entry.eventSlug, entry.marketSlug);
      } catch (error) {
        // Transport failure: transient, so it does NOT count as answered and
        // the bucket stays unmarked, which is what makes the next tick retry.
        this.#logFailure(
          {
            trace_id,
            stage: 'market_intelligence',
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
        // Slug rot, and the loudest case in this file. A decayed table degrades
        // to silent zero-ingest — the exact mute-analyst state this source
        // exists to relieve — so it is a warn naming the row to edit, never an
        // info nobody greps for.
        this.#log({
          trace_id,
          stage: 'market_intelligence',
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
        // Gamma ANSWERED — with "there is no such market". A decayed table is a
        // durable state, not an outage, so re-asking inside the hour repeats it.
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
      // The bucket is marked only when SOMETHING answered: a pass in which
      // every row failed on a TRANSPORT — Gamma's or the CLOB's, see
      // `BuiltRow` — is a vendor outage and must be retried, while a pass in
      // which every row was refused on book quality, or rotted, is a real
      // answer and re-asking within the hour would only repeat it.
      if (answered > 0) this.#bucket = bucketAt.getTime();
      return false;
    }

    try {
      // Raw bytes AND the derived items (#835). This wrote `[]` for the items
      // because `MiIngestAgent.hydrate()` reloaded archived items
      // source-agnostically at startup, so an archived item here would have a
      // restart re-serve a trailing-window statistic as if it were current —
      // and, since `MarketIntelligenceStore.ingest` does no dedup by `id`,
      // compound the time-axis inflation limitation 3 records. That bought the
      // boot property by giving up replay: this source could not be replayed as
      // items at all, and its `news` contribution vanished on restart with
      // nothing on disk to rebuild it from, against the spec's user stories
      // 26/29/30. `archive/mi-sources.ts` now carries the boot policy per
      // source, so both properties hold: the items are archived, and
      // `HYDRATING_MI_SOURCES` excludes this one from the boot read.
      this.#deps.archive?.write(raws, archivedItems);
      this.#deps.store.ingest({
        agent_id: SOURCE_POLYMARKET,
        // The envelope stamp, which `MarketIntelligenceStore.ingest` carries
        // but never reads — it filters on the ITEM timestamp. Set to the same
        // ingest instant the items carry so the two cannot disagree.
        timestamp: now,
        asset_class: POLYMARKET_ASSET_CLASS,
        items,
      });
    } catch (error) {
      this.#logFailure(
        {
          trace_id,
          stage: 'market_intelligence',
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

  /** One curated row → an item, a logged refusal, or a transport failure. */
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

    // #833. Above the price-history fetch on purpose: a pinned row can never
    // produce a signal, so the CLOB call is wasted, and running the check
    // AFTER `refuseOnBook` keeps every existing refusal reason unchanged for a
    // row that is thin AND pinned. Routed through `#refuse` like every other
    // book-quality refusal, so the row still counts as ANSWERED and the
    // bucket marks — this is a durable property of the contract, not an
    // outage, and re-asking inside the hour would only repeat it.
    const probability = market.outcomePrices[outcomeIndex];
    if (probability === undefined || !Number.isFinite(probability)) {
      return this.#refuse(trace_id, entry, 'the bullish outcome carries no quoted probability', now);
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
      // same id, and the archive's natural key absorbs a repeated write.
      id: `${SOURCE_POLYMARKET}:${entry.id}:${bucketAt.toISOString()}`,
      source: SOURCE_POLYMARKET,
      type: 'news',
      // `now`, the INGEST INSTANT — never the floored bucket. `getContext`
      // floors its window end to the debate bar and drops anything stamped
      // past it (#782), and that dropping is the feature, not an obstacle: it
      // is what stops `news.length` moving between two ticks of ONE bar.
      // `technical-analyst` puts that count verbatim in `key_points`, which is
      // hashed into `debate_id`, so a count that grows mid-bar buys a SECOND
      // paid debate on a bar that already had one (#617, ADR-0008's budget) —
      // and `fundamental-analyst` emits a second, different confidence on the
      // same bar, which `scale_in_conviction_delta` can turn into an extra lot.
      //
      // Stamping `bucketAt` backdates the item INTO the already-open bar and
      // re-opens exactly that. The poll timer is 15 minutes at an arbitrary
      // phase and the tick interval is 60s, so an ingest at 10:11 stamped 10:00
      // is visible to a read at 10:12 and was not visible at 10:05.
      // `market-intelligence-spec.md` states the contract this now honours:
      // "an item ingested mid-bar is not visible until the next bar opens" —
      // at most one hour of latency against a 24h window, on a path whose
      // consumer runs once per bar anyway.
      //
      // `id` and `native_id` stay keyed to `bucketAt` on purpose: they are the
      // replay/dedup coordinates and must be stable for a replay stepping the
      // same grid, which a wall-clock instant is not.
      timestamp: now,
      entity: entry.entity,
      // A curated macro market is evidence for the whole class and for no one
      // instrument: `entry.entity` is a series name (`FOMC-2026-09`), never a
      // ticker. Without this the item is dropped by `getContext`'s entity
      // filter for every entity-scoped caller (#914) — which is both analysts
      // that read the CONTENT — while still reaching `technical-analyst`,
      // whose read passes no entity, as a bare `news.length`.
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
      // The VENDOR's revision stamp, not ours — `updated_at` orders revisions,
      // `ingested_at` is the visibility gate (`mi-archive-store.ts`). Guarded
      // as defined by `refuseOnBook` above.
      updated_at: market.updatedAt ?? bucketAt,
      payload: JSON.stringify({
        market: market.payload,
        baseline: { at: baseline.at.toISOString(), p: baseline.probability },
        latest: { at: latest.at.toISOString(), p: latest.probability },
      }),
      ingested_at: now,
      // 'live' because we fetched it now and stamped it with the bucket we
      // fetched it in — the row asserts nothing we did not know.
      fidelity: 'live',
    };

    // The row answered, so its refusal streak starts over: the escalation must
    // fire on a row that is dead, not on one that was quiet last Tuesday.
    this.#refusals.delete(entry.id);
    this.#deps.archive?.clearRefusalStreak(SOURCE_POLYMARKET, entry.id);
    return { outcome: 'item', item, raw };
  }

  #refuse(trace_id: string, entry: CuratedMacroMarket, reason: string, now: Date): BuiltRow {
    const streak = this.#nextRefusalStreak(entry.id);
    this.#refusals.set(entry.id, streak);
    this.#deps.archive?.recordRefusalStreak(SOURCE_POLYMARKET, entry.id, streak, reason, now);
    // A row parked below the book-quality floors forever is functionally a
    // rotted row: it never contributes, and nobody greps `info`. One refusal is
    // routine (a quiet hour on a market that trades around a print), so the
    // first day stays `info`; past a full day of consecutive refusals the row
    // is not quiet, it is dead, and that has to reach the same eyes slug rot
    // does. Measured 2026-08-17: 3 of the 6 curated rows sit below the volume
    // floor today, so this is the common path, not an edge (see the PR body).
    const persistent = streak >= REFUSAL_WARN_STREAK;
    this.#log({
      trace_id,
      stage: 'market_intelligence',
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
   * The next streak value for `id` (#1120). Continues the in-memory count on
   * a hit; on this process's first refusal for `id` it falls back to what the
   * archive already had persisted rather than 0, which is what makes the
   * escalation resume after a restart instead of restarting at 1 — the exact
   * failure that let a permanently-dead row read as merely occasional on a
   * soak that bounces more than once a day.
   */
  #nextRefusalStreak(id: string): number {
    const inMemory = this.#refusals.get(id);
    if (inMemory !== undefined) return inMemory + 1;
    return (this.#deps.archive?.refusalStreak(SOURCE_POLYMARKET, id) ?? 0) + 1;
  }
}
