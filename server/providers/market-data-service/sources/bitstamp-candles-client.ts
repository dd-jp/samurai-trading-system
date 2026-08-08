/**
 * Bitstamp OHLC — the CRYPTO FALLBACK for the #512 warm-start backfill
 * script (#496), and ONLY that. Not a `DataSource` port implementation
 * (`../market-data-service/sources/`); the live composition root
 * (`src/orchestrator/production.ts`) never imports this module — see
 * `backfill-market-data.ts`'s module doc for the composition-root trace.
 *
 * ADR-0001 / `docs/research/free-ohlcv-fallback-sources-2026-08-06.md` name
 * Bitstamp `/api/v2/ohlc` as the crypto fallback: no key, no account, true
 * USD pairs (`btcusd`/`ethusd` — not USDT proxies), depth back to
 * 2011-08-18 for BTC:
 *
 *   GET https://www.bitstamp.net/api/v2/ohlc/{pair}/?step=<seconds>&limit=<n>&start=<unix>
 *
 * Response (PROBED live 2026-08-07): `{ data: { pair, ohlc: [{ timestamp,
 * open, high, low, close, volume }] } }`, ASCENDING by timestamp (the
 * OPPOSITE of `CoinbaseCandlesClient`'s newest-first), and every OHLCV field
 * a STRING — also unlike Coinbase's numeric wire types. `parseCandle`/
 * `parseNumberField` below are the one place both conventions are handled;
 * this client still sorts explicitly rather than trusting the wire order,
 * matching `CoinbaseCandlesClient`'s belt-and-braces posture.
 *
 * ⚠️ Pagination caveat (research doc, "Caveat — PROBED"): advancing with
 * `start = last_timestamp + step` returns ONE OVERLAPPING bar at the
 * boundary — a naive multi-request `append` would double-count that day.
 * This client makes a single bounded request per call (the backfill
 * script's windows top out at `lookback: 30`, far under Bitstamp's
 * 1000-bar-per-request cap, so no pagination loop exists here at all), but
 * a defensive dedup-by-close_time still runs below, in case a future caller
 * widens `limit` past 1000 and starts paginating, or Bitstamp itself ever
 * repeats a boundary row within one response.
 */

import { fetchWithTimeout, type TokenBucket } from '../../../shared/index.js';
import type { Bar } from '../index.js';
import { closeTimeOf, timeframeToMs } from '../index.js';

const BASE_URL = 'https://www.bitstamp.net';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Bitstamp's documented hard per-request cap. */
const MAX_CANDLES_PER_REQUEST = 1000;
/** Headroom over the requested `limit`, matching `CoinbaseCandlesClient`'s posture. */
const REQUEST_BUFFER_MULTIPLIER = 2;
/** Bitstamp's `step` only accepts these values — https://www.bitstamp.net/api/ "OHLC data". */
const SUPPORTED_STEP_SECONDS = new Set([
  60, 180, 300, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400, 259200,
]);

interface RawCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BitstampOhlcResponse {
  data?: { ohlc?: unknown };
}

/** `'1h'` -> 3600, `'1d'` -> 86400 — throws on a timeframe Bitstamp's `step` cannot express. */
function toBitstampStepSeconds(timeframe: string): number {
  const seconds = timeframeToMs(timeframe) / 1000;
  if (!SUPPORTED_STEP_SECONDS.has(seconds)) {
    throw new Error(
      `BitstampCandlesClient: unsupported timeframe '${timeframe}' (${seconds}s) — Bitstamp's ` +
        `OHLC endpoint only accepts step in {${[...SUPPORTED_STEP_SECONDS].join(', ')}}.`,
    );
  }
  return seconds;
}

/** `'BTC-USD'` -> `'btcusd'` — this repo's universe symbol to Bitstamp's pair id. */
export function toBitstampPair(symbol: string): string {
  return symbol.toLowerCase().replace('-', '');
}

/** Every Bitstamp OHLCV field arrives as a STRING (unlike Coinbase's numeric wire types) — parsed and range-checked here rather than cast. */
function parseNumberField(raw: unknown, field: string, symbol: string): number {
  if (typeof raw !== 'string') {
    throw new Error(
      `BitstampCandlesClient: malformed candle for ${symbol} — field '${field}' is not a string.`,
    );
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(
      `BitstampCandlesClient: malformed candle for ${symbol} — field '${field}' is not a finite number.`,
    );
  }
  return value;
}

function parseCandle(raw: unknown, symbol: string, rowIndex: number): RawCandle {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(
      `BitstampCandlesClient: malformed candle for ${symbol} at response index ${rowIndex} — ` +
        'expected an object.',
    );
  }
  const { timestamp, open, high, low, close, volume } = raw as Record<string, unknown>;
  try {
    return {
      timestamp: parseNumberField(timestamp, 'timestamp', symbol),
      open: parseNumberField(open, 'open', symbol),
      high: parseNumberField(high, 'high', symbol),
      low: parseNumberField(low, 'low', symbol),
      close: parseNumberField(close, 'close', symbol),
      volume: parseNumberField(volume, 'volume', symbol),
    };
  } catch (cause) {
    throw new Error(
      `BitstampCandlesClient: malformed candle for ${symbol} at response index ${rowIndex}.`,
      { cause },
    );
  }
}

export interface BitstampCandlesClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Paced via `resolveBitstampPacing()` at the call site — never a bespoke sleep. */
  rateLimiter?: TokenBucket | undefined;
}

/**
 * Fetches the most recent `limit` COMPLETE candles at or before `asOf`,
 * ascending by `close_time` — the same contract `CoinbaseCandlesClient`
 * shares. A short read is returned as-is rather than retried.
 */
export class BitstampCandlesClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly rateLimiter: TokenBucket | undefined;

  constructor(options: BitstampCandlesClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rateLimiter = options.rateLimiter;
  }

  async getBars(symbol: string, timeframe: string, asOf: Date, limit: number): Promise<Bar[]> {
    if (limit <= 0) return [];

    const step = toBitstampStepSeconds(timeframe);
    const requestCandles = Math.min(limit * REQUEST_BUFFER_MULTIPLIER, MAX_CANDLES_PER_REQUEST);
    const start = Math.floor(asOf.getTime() / 1000) - requestCandles * step;
    const pair = toBitstampPair(symbol);

    const params = new URLSearchParams({
      step: String(step),
      limit: String(requestCandles),
      start: String(start),
    });
    const url = `${this.baseUrl}/api/v2/ohlc/${encodeURIComponent(pair)}/?${params.toString()}`;

    await this.rateLimiter?.acquireBackground();

    let response: Response;
    try {
      response = await fetchWithTimeout(url, {}, this.timeoutMs);
    } catch (cause) {
      throw new Error(
        `BitstampCandlesClient: network error fetching ${symbol} ${timeframe} candles.`,
        { cause },
      );
    }

    if (!response.ok) {
      throw new Error(
        `BitstampCandlesClient: ${symbol} ${timeframe} candles request failed with HTTP ${response.status}.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (cause) {
      throw new Error(
        `BitstampCandlesClient: response body for ${symbol} ${timeframe} could not be parsed as JSON.`,
        { cause },
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(
        `BitstampCandlesClient: malformed response for ${symbol} ${timeframe} — expected an object.`,
      );
    }
    const body = parsed as BitstampOhlcResponse;
    const data = body.data;
    if (data === undefined || !Array.isArray(data.ohlc)) {
      throw new Error(
        `BitstampCandlesClient: malformed response for ${symbol} ${timeframe} — expected ` +
          "'data.ohlc' to be an array.",
      );
    }

    // Defensive dedup by close_time (module doc's pagination caveat): a
    // later duplicate overwrites an earlier identical row, which is
    // observably a no-op since both carry the same values by construction.
    const byCloseTime = new Map<number, Bar>();
    data.ohlc.forEach((raw, index) => {
      const candle = parseCandle(raw, symbol, index);
      const open_time = new Date(candle.timestamp * 1000);
      const close_time = closeTimeOf(open_time, timeframe);
      if (close_time.getTime() > asOf.getTime()) return;
      byCloseTime.set(close_time.getTime(), {
        instrument: symbol,
        timeframe,
        open_time,
        close_time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        source: 'bitstamp',
      });
    });

    const bars = [...byCloseTime.values()].sort(
      (a, b) => a.close_time.getTime() - b.close_time.getTime(),
    );
    return bars.slice(-limit);
  }
}
