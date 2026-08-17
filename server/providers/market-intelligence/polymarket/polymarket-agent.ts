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
 * the floor, or a price history that does not span a full 24h. In every one of
 * those cases the analysts report `NO_DATA_MARKER`, which keeps "we could not
 * look" distinguishable from "we looked and saw nothing" — the #463/#474/#485
 * line.
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
 * **2. One direction for a whole asset class.** `getContext` filters by
 * `asset_class` alone, so every item here reaches every `stocks` debate —
 * including SGLN, where a rising recession probability is plausibly BULLISH
 * while it is bearish for 3USL. `IntelligenceItem` has no per-instrument
 * direction to express that with.
 *
 * **3. Time-axis vote inflation.** `MarketIntelligenceStore.ingest` does no
 * dedup by `id`, and `directionFrom` is an unweighted mean of signs — so at
 * an hourly cadence one curated row contributes up to 24 items to the
 * analysts' 24h window. Decision 4 stops one event casting five votes along
 * the OUTCOME axis; the time axis is the same inflation and is not addressed.
 * It is uniform across rows, so it scales the vote count rather than skewing
 * the direction, which is why it is recorded rather than solved here.
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
import type { MiArchiveStore, RawArchiveRow } from '../archive/mi-archive-store.js';
import type { MarketIntelligenceStore } from '../index.js';
import type { IntelligenceItem } from '../types.js';
import type { CuratedMacroMarket } from './curated-markets.js';
import { CURATED_MACRO_MARKETS } from './curated-markets.js';
import type { PolymarketMarket, PolymarketPricePoint } from './polymarket-client.js';

/** The `source` on every item and archive row this agent writes. */
export const SOURCE_POLYMARKET = 'polymarket';

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
 * fraction, because this path is free. It also happens to equal
 * `DEBATE_BAR_TIMEFRAME_MS`, which is what makes the bucket-floored item
 * stamp land exactly on the bar `getContext` floors its window to (#782).
 */
export const POLYMARKET_REFRESH_MS = 60 * 60 * 1000;

/** Below this |delta| the market did not move enough to call a direction. */
export const DEAD_BAND = 0.02;

/** `|delta| * 5` saturates the 0.95 ceiling at a 0.19 move. */
const CONFIDENCE_SCALE = 5;
const MIN_CONFIDENCE = 0.05;
const MAX_CONFIDENCE = 0.95;

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
   * The MI archive, when this run has one. Raw bytes only — see `archiveRows`
   * for why no `ArchivedItem` is written.
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

export class PolymarketAgent {
  /** The bucket already fetched. In-memory: a restart refetches, which is correct. */
  #bucket: number | undefined;
  #current: Promise<boolean> | undefined;
  /** Consecutive book-quality refusals per curated row — see `#refuse`. */
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

      answered += 1;

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
        continue;
      }

      const built = await this.#buildItem(trace_id, entry, market, now, bucketAt);
      if (built === undefined) continue;
      items.push(built.item);
      raws.push(built.raw);
    }

    if (items.length === 0) {
      // The bucket is marked only when SOMETHING answered: a pass in which
      // every row threw is a vendor outage and must be retried, while a pass
      // in which every row was refused on book quality is a real answer and
      // re-asking within the hour would only repeat it.
      if (answered > 0) this.#bucket = bucketAt.getTime();
      return false;
    }

    try {
      // Raw bytes only, NO archived items. `MiIngestAgent.hydrate()` reloads
      // archived ITEMS source-agnostically at startup, so an archived item here
      // would have a restart re-serve a trailing-window statistic as if it were
      // current. The raws still give replay the bytes and smoke a durable row.
      this.#deps.archive?.write(raws, []);
      this.#deps.store.ingest({
        agent_id: SOURCE_POLYMARKET,
        timestamp: bucketAt,
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

  /** One curated row → one item, or `undefined` with the refusal logged. */
  async #buildItem(
    trace_id: string,
    entry: CuratedMacroMarket,
    market: PolymarketMarket,
    now: Date,
    bucketAt: Date,
  ): Promise<{ item: IntelligenceItem; raw: RawArchiveRow } | undefined> {
    const refusal = refuseOnBook(market, now);
    if (refusal !== undefined) return this.#refuse(trace_id, entry, refusal);

    const outcomeIndex = market.outcomes.indexOf(entry.bullishOutcome);
    if (outcomeIndex < 0) {
      return this.#refuse(
        trace_id,
        entry,
        `the curated bullish outcome '${entry.bullishOutcome}' is not among the market's ` +
          `outcomes [${market.outcomes.join(', ')}] — the market's shape changed under the table`,
      );
    }
    const tokenId = market.tokenIds[outcomeIndex];
    if (tokenId === undefined) {
      return this.#refuse(trace_id, entry, 'the bullish outcome has no CLOB token id');
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
            'ingested at all.',
        },
        error,
        { source: SOURCE_POLYMARKET, curated_id: entry.id },
      );
      return undefined;
    }

    const endpoints = endpointsOf(history, now);
    if (typeof endpoints === 'string') return this.#refuse(trace_id, entry, endpoints);

    const { baseline, latest } = endpoints;
    const delta = latest.probability - baseline.probability;
    const item: IntelligenceItem = {
      // Stable per (row, bucket): a replay stepping the same grid rebuilds the
      // same id, and the archive's natural key absorbs a repeated write.
      id: `${SOURCE_POLYMARKET}:${entry.id}:${bucketAt.toISOString()}`,
      source: SOURCE_POLYMARKET,
      type: 'news',
      // The FLOORED bucket, not `now`. `getContext` floors its window end to
      // the debate bar (#782) and drops anything stamped past it, so an item
      // stamped mid-bar would be invisible until the next bar opened.
      timestamp: bucketAt,
      entity: entry.entity,
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
    return { item, raw };
  }

  #refuse(trace_id: string, entry: CuratedMacroMarket, reason: string): undefined {
    const streak = (this.#refusals.get(entry.id) ?? 0) + 1;
    this.#refusals.set(entry.id, streak);
    // A row parked below the book-quality floors forever is functionally a
    // rotted row: it never contributes, and nobody greps `info`. One refusal is
    // routine (a quiet hour on a market that trades around a print), so the
    // first day stays `info`; past a full day of consecutive refusals the row
    // is not quiet, it is dead, and that has to reach the same eyes slug rot
    // does. Measured 2026-08-17: 5 of the 8 curated rows sit below the volume
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
    return undefined;
  }
}
