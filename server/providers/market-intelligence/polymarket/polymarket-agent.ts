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

export const SOURCE_POLYMARKET = MI_SOURCES.polymarket;

export const POLYMARKET_ASSET_CLASS: AssetClass = 'stocks';

const POLYMARKET_REFRESH_MS = 60 * 60 * 1000;

const DEAD_BAND = 0.02;

const CONFIDENCE_SCALE = 5;
const MIN_CONFIDENCE = 0.05;
const MAX_CONFIDENCE = 0.95;

const MIN_PROBABILITY_HEADROOM = 0.1;

const MAX_SPREAD = 0.05;
const MIN_VOLUME_24H_USD = 100;
const MIN_LIQUIDITY_USD = 5_000;

const MAX_UPDATED_AGE_MS = 6 * 60 * 60 * 1000;

const DELTA_WINDOW_MS = 24 * 60 * 60 * 1000;

const BASELINE_TOLERANCE_MS = 2 * 60 * 60 * 1000;

const REFUSAL_WARN_STREAK = 24;

const MAX_LATEST_POINT_AGE_MS = 3 * 60 * 60 * 1000;

export interface PolymarketWireClient {
  fetchEventMarket(eventSlug: string, marketSlug: string): Promise<PolymarketMarket | undefined>;
  fetchPriceHistory(tokenId: string): Promise<PolymarketPricePoint[]>;
}

export interface PolymarketAgentDeps {
  client: PolymarketWireClient;
  store: MarketIntelligenceStore;
  clock: Clock;
  archive?: MiArchiveStore | undefined;
  logger?: Logger | undefined;
  table?: readonly CuratedMacroMarket[];
  refreshMs?: number;
}

function floorToPolymarketBucket(at: Date, refreshMs: number = POLYMARKET_REFRESH_MS): Date {
  return new Date(Math.floor(at.getTime() / refreshMs) * refreshMs);
}

function signOfDelta(delta: number): 1 | 0 | -1 {
  if (delta > DEAD_BAND) return 1;
  if (delta < -DEAD_BAND) return -1;
  return 0;
}

function isPinnedProbability(probability: number): boolean {
  return Math.min(probability, 1 - probability) < MIN_PROBABILITY_HEADROOM - 1e-9;
}

function confidenceOfDelta(delta: number): number {
  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, Math.abs(delta) * CONFIDENCE_SCALE));
}

type Refusal = string | undefined;

function bookSpread(market: PolymarketMarket): number | undefined {
  if (market.spread !== undefined) return market.spread;
  if (market.bestBid === undefined || market.bestAsk === undefined) return undefined;
  return market.bestAsk - market.bestBid;
}

function refuseOnBook(market: PolymarketMarket, now: Date): Refusal {
  const hasQuote = market.bestBid !== undefined && market.bestAsk !== undefined;
  const spread = bookSpread(market);

  const rules: ReadonlyArray<readonly [failed: boolean, reason: string]> = [
    [market.closed, 'the market is closed'],
    [market.updatedAt === undefined, 'the market carries no updatedAt stamp'],
    [
      market.updatedAt !== undefined &&
        now.getTime() - market.updatedAt.getTime() > MAX_UPDATED_AGE_MS,
      `the market's updatedAt is ${market.updatedAt?.toISOString()}, past the staleness bound`,
    ],
    [!hasQuote, 'the market has no live bid/ask'],
    [
      hasQuote && spread !== undefined && spread > MAX_SPREAD,
      `the spread is ${spread}, past ${MAX_SPREAD}`,
    ],
    [
      market.volume24hr === undefined || market.volume24hr < MIN_VOLUME_24H_USD,
      `24h volume is ${market.volume24hr ?? 'absent'}, below ${MIN_VOLUME_24H_USD}`,
    ],
    [
      market.liquidity === undefined || market.liquidity < MIN_LIQUIDITY_USD,
      `liquidity is ${market.liquidity ?? 'absent'}, below ${MIN_LIQUIDITY_USD}`,
    ],
  ];
  for (const [failed, reason] of rules) {
    if (failed) return reason;
  }
  return undefined;
}

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

type BuiltRow =
  | { outcome: 'item'; item: IntelligenceItem; raw: RawArchiveRow }
  | { outcome: 'refused' }
  | { outcome: 'transport-failed' };

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
  readonly #refusals = new Map<string, number>();
  readonly #deps: PolymarketAgentDeps;
  readonly #refreshMs: number;
  readonly #table: readonly CuratedMacroMarket[];

  constructor(deps: PolymarketAgentDeps) {
    this.#deps = deps;
    this.#refreshMs = deps.refreshMs ?? POLYMARKET_REFRESH_MS;
    this.#table = deps.table ?? CURATED_MACRO_MARKETS;
  }

  #log(entry: LogEntry): void {
    const logger = this.#deps.logger;
    if (logger !== undefined) safeLog(logger, entry);
  }

  #logFailure(template: LogEntryTemplate, error: unknown, payload: Record<string, unknown>): void {
    const logger = this.#deps.logger;
    if (logger !== undefined) logCaughtFailure(logger, template, error, payload);
  }

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

  async whenIdle(): Promise<void> {
    await this.#current?.catch(() => undefined);
  }

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
      if (answered > 0) this.#bucket = bucketAt.getTime();
      return false;
    }

    try {
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
      timestamp: now,
      entity: entry.entity,
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

  #nextRefusalStreak(id: string): number {
    const inMemory = this.#refusals.get(id);
    if (inMemory !== undefined) return inMemory + 1;
    return (this.#deps.archive?.refusalStreak(SOURCE_POLYMARKET, id) ?? 0) + 1;
  }
}
