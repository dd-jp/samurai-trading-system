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
  /** Exchange id for provenance: 'kraken' (default), 'coinbase', ... */
  source?: string | undefined;
  /** Bar granularity backtest marks derive from. */
  markTimeframe?: string | undefined;
  /**
   * How far back of extra history to request beyond the requested bar count.
   * See `DEFAULT_GAP_TOLERANCE_MS`. Raise it for instruments that can go dark
   * for longer than the default.
   */
  gapToleranceMs?: number | undefined;
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

export class CcxtDataSource extends NormalizingDataSource {
  readonly #client: CcxtClient;
  readonly #markTimeframe: string;
  readonly #gapToleranceMs: number;

  constructor(client: CcxtClient, options: CcxtSourceOptions = {}) {
    super({
      source: options.source ?? 'kraken',
      asset_class: 'crypto',
      calendar: new AlwaysOpenCalendar(),
    });
    this.#client = client;
    this.#markTimeframe = options.markTimeframe ?? '1m';
    this.#gapToleranceMs = options.gapToleranceMs ?? DEFAULT_GAP_TOLERANCE_MS;
  }

  protected override get markTimeframe(): string {
    return this.#markTimeframe;
  }

  protected override async fetchRawCandles(
    instrument: string,
    timeframe: string,
    asOf: Date,
    limit: number,
  ): Promise<RawCandle[]> {
    const intervalMs = timeframeToMs(timeframe);
    const span = limit * intervalMs + this.#gapToleranceMs;
    const since = asOf.getTime() - span;
    // ccxt counts `limit` bars FORWARD from `since`, so it must span the whole
    // widened window — passing the caller's bar count here would return the
    // OLDEST bars in it. `completedBars` trims back to the requested count.
    const rows = await this.#client.fetchOHLCV(
      instrument,
      timeframe,
      since,
      Math.ceil(span / intervalMs),
    );

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
