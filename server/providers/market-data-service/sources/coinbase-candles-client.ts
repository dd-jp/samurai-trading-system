/**
 * Coinbase Exchange public candles — the crypto leg of the #512 warm-start
 * backfill script, and ONLY that. Not a `DataSource` port implementation
 * (`../market-data-service/sources/`); the live composition root
 * (`server/apps/orchestrator/production.ts`) never imports this module.
 *
 * ADR-0001 ("Appendix: Broker/Data — historical OHLCV sourcing" table,
 * `docs/adr/0001-technical-foundation-hybrid.md:60`) names Coinbase Exchange
 * public candles as the crypto PRIMARY, sourced from
 * `docs/research/free-crypto-ohlcv-2026-08-06.md`. No key, no account:
 *
 *   GET https://api.exchange.coinbase.com/products/{product_id}/candles
 *       ?granularity=<seconds>&start=<ISO8601>&end=<ISO8601>
 *
 * Response: array of `[time, low, high, open, close, volume]`, NEWEST FIRST.
 * `time` is a Unix-second timestamp of the candle's UTC OPEN (research doc,
 * "Coinbase: exact call pattern and measured limits") — the same open-time
 * convention `timeframe.ts`'s `closeTimeOf` already assumes for ccxt/IBKR/
 * Alpaca, so no extra translation is needed to derive `close_time`.
 *
 * ⚠️ Field order is `low, high, open, close` — NOT the conventional OHLC
 * order. Reading it positionally as OHLC silently swaps open/low and
 * close/high (research doc's explicit warning). `parseCandleRow` below is
 * the one place that mapping happens, and its test pins a fixture row where
 * `low !== open` specifically to catch that mistake.
 */
import { fetchWithTimeout, type TokenBucket } from '../../../shared/index.js';
import type { Bar } from '../index.js';
import { closeTimeOf, timeframeToMs } from '../index.js';

const BASE_URL = 'https://api.exchange.coinbase.com';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Coinbase's hard per-request cap (research doc: "errors rather than truncating"). */
const MAX_CANDLES_PER_REQUEST = 300;
/** Headroom over the requested `limit` so an isolated missing candle (rare, unobserved in the 5y probe) still clears `limit` after the close_time<=asOf filter. */
const REQUEST_BUFFER_MULTIPLIER = 2;

interface RawCandle {
  time: number;
  low: number;
  high: number;
  open: number;
  close: number;
  volume: number;
}

/** One raw Coinbase candle row, positionally: `[time, low, high, open, close, volume]`. */
function parseCandleRow(row: unknown, symbol: string, rowIndex: number): RawCandle {
  if (!Array.isArray(row) || row.length !== 6) {
    throw new Error(
      `CoinbaseCandlesClient: malformed candle row for ${symbol} at response index ${rowIndex} ` +
        `— expected a 6-element array, got ${
          Array.isArray(row) ? `an array of length ${row.length}` : `a ${typeof row}`
        }.`,
    );
  }
  const [time, low, high, open, close, volume] = row;
  const fields = { time, low, high, open, close, volume };
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `CoinbaseCandlesClient: malformed candle row for ${symbol} at response index ${rowIndex} ` +
          `— field '${name}' is not a finite number.`,
      );
    }
  }
  return fields as RawCandle;
}

/** `'1h'` -> 3600, `'1d'` -> 86400 — Coinbase's granularity is seconds, and `timeframeToMs` already carries the same width in ms. */
function toGranularitySeconds(timeframe: string): number {
  return timeframeToMs(timeframe) / 1000;
}

export interface CoinbaseCandlesClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Paced via `resolveCoinbasePacing()` at the call site — never a bespoke sleep (#512 AC). */
  rateLimiter?: TokenBucket | undefined;
}

/**
 * Fetches the most recent `limit` COMPLETE candles at or before `asOf`,
 * ascending by `close_time` — the same contract `AlpacaHttpDataClient.getBars`
 * and `MarketDataServiceImpl.getBars` share. A short read (fewer than
 * `limit` rows after filtering) is returned as-is rather than retried; the
 * backfill script's own coverage report is what surfaces that, not a thrown
 * error here — see `backfill-market-data.ts`.
 */
export class CoinbaseCandlesClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly rateLimiter: TokenBucket | undefined;

  constructor(options: CoinbaseCandlesClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rateLimiter = options.rateLimiter;
  }

  async getBars(symbol: string, timeframe: string, asOf: Date, limit: number): Promise<Bar[]> {
    if (limit <= 0) return [];

    const granularitySeconds = toGranularitySeconds(timeframe);
    const requestCandles = Math.min(limit * REQUEST_BUFFER_MULTIPLIER, MAX_CANDLES_PER_REQUEST);
    const start = new Date(asOf.getTime() - requestCandles * granularitySeconds * 1000);

    const params = new URLSearchParams({
      granularity: String(granularitySeconds),
      start: start.toISOString(),
      end: asOf.toISOString(),
    });
    const url = `${this.baseUrl}/products/${encodeURIComponent(symbol)}/candles?${params.toString()}`;

    await this.rateLimiter?.acquireBackground();

    let response: Response;
    try {
      response = await fetchWithTimeout(url, {}, this.timeoutMs);
    } catch (cause) {
      throw new Error(
        `CoinbaseCandlesClient: network error fetching ${symbol} ${timeframe} candles.`,
        { cause },
      );
    }

    if (!response.ok) {
      throw new Error(
        `CoinbaseCandlesClient: ${symbol} ${timeframe} candles request failed with HTTP ${response.status}.`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new Error(
        `CoinbaseCandlesClient: response body for ${symbol} ${timeframe} could not be parsed as JSON.`,
        { cause },
      );
    }

    if (!Array.isArray(body)) {
      throw new Error(
        `CoinbaseCandlesClient: malformed response for ${symbol} ${timeframe} — expected an array, ` +
          `got a ${typeof body}.`,
      );
    }

    const bars: Bar[] = body
      .map((row, index) => parseCandleRow(row, symbol, index))
      .map((candle): Bar => {
        const openTime = new Date(candle.time * 1000);
        return {
          instrument: symbol,
          timeframe,
          open_time: openTime,
          close_time: closeTimeOf(openTime, timeframe),
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          source: 'coinbase',
        };
      })
      .filter((bar) => bar.close_time.getTime() <= asOf.getTime())
      .sort((a, b) => a.close_time.getTime() - b.close_time.getTime());

    return bars.slice(-limit);
  }
}
