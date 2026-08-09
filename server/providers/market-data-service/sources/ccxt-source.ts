/**
 * Crypto DataSource via ccxt (ticket #66).
 * See docs/specs/market-data-service-spec.md (Module: Ingestion & Sources):
 * "ccxt WebSocket (Kraken first; Coinbase Advanced swappable by config) ...
 * ccxt REST `fetchOHLCV` backfills history." 24/7 — no session gating.
 *
 * The ccxt exchange itself is INJECTED, not constructed here: connection
 * provisioning (API keys, WebSocket subscriptions) is an ops/setup task, not
 * this spec's logic (spec Dependencies). `CcxtClient` is the narrow slice of
 * the ccxt Exchange surface this source uses, so a real exchange instance
 * satisfies it structurally.
 *
 * That injection is also why REQUEST PACING is not applied here (#497 review
 * point). Pagination turns one `fetchOHLCV` into several, but the client that
 * issues them is the caller's — a real ccxt Exchange paces itself via
 * `enableRateLimit`, and `DEFAULT_VENUE_PACING.ccxt` paces the execution
 * adapter that owns its own transport. A second bucket wrapped around an
 * already-paced client would throttle twice and make neither number mean
 * anything. What this module owes instead is a BOUND on how many requests a
 * single call can cost, which `maxPages` below provides.
 */

import type { RawCandle } from '../ingestion.js';
import { timeframeToMs } from '../timeframe.js';
import { AlwaysOpenCalendar } from '../trading-calendar.js';
import { type LiveObservation, NormalizingDataSource } from './normalizing-data-source.js';

/** ccxt's OHLCV tuple: [timestamp, open, high, low, close, volume]. */
export type CcxtOhlcv = [number, number, number, number, number, number];

/** The ccxt ticker fields this source reads; both are optional in ccxt. */
export interface CcxtTicker {
  last: number | undefined;
  timestamp: number | undefined;
}

export interface CcxtClient {
  fetchOHLCV(
    symbol: string,
    timeframe: string,
    since?: number,
    limit?: number,
  ): Promise<CcxtOhlcv[]>;
  fetchTicker(symbol: string): Promise<CcxtTicker>;
}

export interface CcxtSourceOptions {
  /**
   * Exchange id, written verbatim as each bar's `source` provenance.
   *
   * REQUIRED, and that is the point (#497). It used to default to `'kraken'`,
   * which #487 made actively wrong: the crypto stack settled on Coinbase
   * primary / Bitstamp fallback, and Kraken is the one venue that provably
   * CANNOT serve history — hard-capped at 720 candles, reconfirmed in #484.
   * So the old default silently routed history reads to the worst available
   * option AND stamped every resulting bar with a venue that never served it.
   *
   * A wrong default is worse than a missing one here because `source` is
   * provenance: it outlives the call, gets stored, and is what a later reader
   * uses to decide whether a bar is trustworthy. Requiring it makes the
   * caller state which venue it actually holds, and there is no silent
   * fallback to be wrong about.
   */
  source: string;
  /** Bar granularity backtest marks derive from. */
  markTimeframe?: string | undefined;
  /**
   * How far back of extra history to request beyond the requested bar count.
   * See `DEFAULT_GAP_TOLERANCE_MS`. Raise it for instruments that can go dark
   * for longer than the default.
   */
  gapToleranceMs?: number | undefined;
  /**
   * Bars requested per `fetchOHLCV` call. See `DEFAULT_PAGE_LIMIT`. Raise it
   * for a venue with a higher per-response cap to spend fewer requests on the
   * same window; lowering it below the venue's cap only costs extra calls.
   */
  pageLimit?: number | undefined;
}

/**
 * ccxt's `fetchOHLCV(since, limit)` returns bars FORWARD FROM `since`, so a
 * window back-computed from the bar count alone (`asOf - limit * interval`)
 * silently returns nothing whenever the most recent bar is older than that
 * span — i.e. across any gap in trading: a weekend, a holiday, a halt, or a
 * thinly-traded instrument that simply printed no candles. That empties the
 * backtest mark derivation, which then throws instead of returning the last
 * known price.
 *
 * So the request window is widened by a gap tolerance: how far back a bar may
 * be and still be found. Over-fetched bars are harmless — `completedBars`
 * trims to the requested count. Seven days clears a long weekend plus an
 * adjacent holiday.
 */
const DEFAULT_GAP_TOLERANCE_MS = 7 * 86_400_000;

/**
 * Bars asked for per request, set to the SMALLEST cap among the venues #487
 * put in play so the default is correct everywhere rather than optimal
 * somewhere: Coinbase 300 and Crypto.com 300 (Bitstamp allows 1000, Kraken
 * 720 — see `docs/research/31-free-ohlcv-evidence.md`).
 *
 * Asking for more than a venue serves is not an error — it silently returns
 * its cap, which is exactly the failure #497 is about. The loop below does
 * not trust this number for control flow: it advances from the timestamps it
 * actually received, so a venue that serves fewer costs more requests and
 * still yields the full window. This constant governs COST, never
 * correctness.
 */
const DEFAULT_PAGE_LIMIT = 300;

/**
 * Floor for the per-call request budget, so a small window still gets a
 * couple of retries' worth of slack before the guard trips.
 */
const MIN_PAGES = 3;

/**
 * Raised when pagination is still not done after the window's own request
 * budget. Mirrors `AlpacaHttpDataClient`'s `next_page_token` guard: a venue
 * that keeps answering without ever reaching `asOf` must stop the walk rather
 * than spend an unbounded number of calls on a shared rate-limit budget.
 */
export class CcxtPaginationError extends Error {
  constructor(details: { instrument: string; timeframe: string; pages: number; received: number }) {
    super(
      `CcxtDataSource.fetchRawCandles: ${details.instrument} ${details.timeframe} did not cover ` +
        `the requested window within ${details.pages} requests (${details.received} bars so far). ` +
        'Refusing to page further — a venue that never reaches asOf is either misreporting ' +
        'timestamps or serving a far smaller cap than pageLimit assumes.',
    );
    this.name = 'CcxtPaginationError';
  }
}

/**
 * Raised when the venue is out of history before the caller's bar count is
 * met — the ccxt half of the residual gap `NormalizingDataSource.fetchBars`
 * documents at its raw-scarcity branch ("Closing that belongs with those
 * sources' own guards, not here").
 *
 * This is deliberately a DIFFERENT condition from `CcxtPaginationError`, and
 * pagination is what makes the two separable at all. Before #497 a single
 * capped response was indistinguishable from exhausted history, so neither
 * error could be raised honestly. Now a short read is only reported once the
 * walk has actually stopped making progress, which means it is scarcity.
 *
 * Never retryable: repeating an identical request cannot conjure bars that do
 * not exist. `partial: 'allow'` is the caller's opt-in to a short window and
 * skips this entirely, matching `AlpacaDataUnderfetchError` (#292).
 */
export class CcxtDataUnderfetchError extends Error {
  readonly instrument: string;
  readonly timeframe: string;
  /** Raw candles the caller asked for. */
  readonly requested: number;
  /** Raw candles the paginated walk actually produced. */
  readonly received: number;
  /** Start of the widened range searched, ISO-8601. */
  readonly searchedFrom: string;
  /** `asOf` — the point-in-time boundary, never widened. */
  readonly searchedTo: string;
  /** Requests the walk spent before concluding history was exhausted. */
  readonly pages: number;

  constructor(details: {
    instrument: string;
    timeframe: string;
    requested: number;
    received: number;
    searchedFrom: string;
    searchedTo: string;
    pages: number;
  }) {
    super(
      `CcxtDataSource.fetchRawCandles: ${details.instrument} ${details.timeframe} produced ` +
        `${details.received} raw candles for a requested ${details.requested} over ` +
        `${details.searchedFrom}..${details.searchedTo} after ${details.pages} request(s), and ` +
        'pagination stopped making progress — the venue has no more history. Refusing to ' +
        'return a short window silently: an indicator computed over fewer bars than the caller ' +
        "asked for is wrong, not merely degraded. Pass partial: 'allow' if this call site " +
        'genuinely tolerates fewer bars.',
    );
    this.name = 'CcxtDataUnderfetchError';
    this.instrument = details.instrument;
    this.timeframe = details.timeframe;
    this.requested = details.requested;
    this.received = details.received;
    this.searchedFrom = details.searchedFrom;
    this.searchedTo = details.searchedTo;
    this.pages = details.pages;
  }
}

export class CcxtDataSource extends NormalizingDataSource {
  readonly #client: CcxtClient;
  readonly #markTimeframe: string;
  readonly #gapToleranceMs: number;
  readonly #pageLimit: number;

  constructor(client: CcxtClient, options: CcxtSourceOptions) {
    super({
      source: options.source,
      asset_class: 'crypto',
      calendar: new AlwaysOpenCalendar(),
    });
    this.#client = client;
    this.#markTimeframe = options.markTimeframe ?? '1m';
    this.#gapToleranceMs = options.gapToleranceMs ?? DEFAULT_GAP_TOLERANCE_MS;
    this.#pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  }

  protected override get markTimeframe(): string {
    return this.#markTimeframe;
  }

  /**
   * Walks `fetchOHLCV` forward until the window is covered (#497).
   *
   * Every venue caps a single OHLCV response — 300 candles on Coinbase, 720
   * on Kraken — and reports the cap as SUCCESS. One unpaginated call for five
   * years of daily bars therefore returned ~300 bars with no error, and the
   * layer above read that as "the venue has no more history" (see
   * `NormalizingDataSource.fetchBars`'s `candles.length < rawLimit` branch),
   * so a truncated series propagated as a complete one.
   *
   * TERMINATION is on FORWARD PROGRESS, not on an empty page. A venue that
   * keeps re-serving the same first page answers non-empty forever, so an
   * empty-page check alone would spin. Each iteration therefore requires the
   * newest timestamp to be strictly greater than the last one kept; anything
   * at or behind it ends the walk. `maxPages` is the backstop for the case
   * that satisfies even that — timestamps advancing by less than the cursor
   * step, which no correct venue does but a misreporting one might.
   *
   * The cursor steps to `last + interval` rather than `last`, because ccxt's
   * `since` is INCLUSIVE: reusing `last` would re-fetch the bar just kept and
   * pay a request per bar at the tail of the window.
   */
  protected override async fetchRawCandles(
    instrument: string,
    timeframe: string,
    asOf: Date,
    limit: number,
    partial?: 'error' | 'allow',
  ): Promise<RawCandle[]> {
    if (limit <= 0) return [];

    const intervalMs = timeframeToMs(timeframe);
    const span = limit * intervalMs + this.#gapToleranceMs;
    const from = asOf.getTime() - span;
    const targetBars = Math.ceil(span / intervalMs);
    // Scaled to the window actually being walked, so a large request trips on
    // its own size rather than on a fixed cap, with the same +2 pages of
    // boundary slack `AlpacaHttpDataClient` uses.
    const maxPages = Math.max(MIN_PAGES, Math.ceil(targetBars / this.#pageLimit) + 2);

    const rows: CcxtOhlcv[] = [];
    let since = from;
    let lastTimestamp = Number.NEGATIVE_INFINITY;
    let pages = 0;

    while (true) {
      pages++;
      const page = await this.#client.fetchOHLCV(instrument, timeframe, since, this.#pageLimit);
      // Venues may echo the `since` bar or, on a re-served page, bars already
      // held. Only strictly-newer candles count, so duplicates can neither
      // inflate the count that the underfetch guard reads nor be mistaken for
      // progress.
      const fresh = page.filter(([timestamp]) => timestamp > lastTimestamp);
      if (fresh.length === 0) break;

      rows.push(...fresh);
      const newest = fresh[fresh.length - 1]?.[0];
      if (newest === undefined || newest <= lastTimestamp) break;
      lastTimestamp = newest;

      // The next bar would open at or after asOf, so there is nothing left
      // inside the window to ask for.
      if (lastTimestamp + intervalMs >= asOf.getTime()) break;
      if (pages >= maxPages) {
        throw new CcxtPaginationError({ instrument, timeframe, pages, received: rows.length });
      }
      since = lastTimestamp + intervalMs;
    }

    // Checked against the caller's raw `limit`, not the gap-widened
    // `targetBars`: the tolerance exists to FIND bars across a gap, not to
    // raise the bar count anyone actually asked for.
    if (partial !== 'allow' && rows.length < limit) {
      throw new CcxtDataUnderfetchError({
        instrument,
        timeframe,
        requested: limit,
        received: rows.length,
        searchedFrom: new Date(from).toISOString(),
        searchedTo: asOf.toISOString(),
        pages,
      });
    }

    return rows.map(([timestamp, open, high, low, close, volume]) => ({
      open_time: new Date(timestamp),
      open,
      high,
      low,
      close,
      volume,
    }));
  }

  protected override async fetchLiveObservation(instrument: string): Promise<LiveObservation> {
    const ticker = await this.#client.fetchTicker(instrument);
    if (ticker.last === undefined || ticker.timestamp === undefined) {
      throw new Error(`ccxt ticker for ${instrument} has no last price/timestamp to observe`);
    }

    return { price: ticker.last, observed_at: new Date(ticker.timestamp) };
  }
}
