import {
  fetchWithTimeout,
  type RetryConfig,
  type TokenBucket,
  toPolygonDate,
  truncateForError,
  validateRawPolygonAggregate,
  withRetry,
} from '../../../shared/index.js';
import { closeTimeOf, isDailyTimeframe, timeframeToMs } from '../timeframe.js';
import type { Bar } from '../types.js';
import {
  classifyPolygonBarsNetworkError,
  classifyPolygonBarsResponse,
  isRetryablePolygonBarsError,
} from './polygon-bars-errors.js';

const DEFAULT_BASE_URL = 'https://api.polygon.io';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_CONFIG: RetryConfig = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 };
const PAGE_LIMIT = 50_000;
const REQUEST_BUFFER_MULTIPLIER = 2;
const MIN_DAILY_BUFFER_MS = 4 * 86_400_000;

interface PolygonAggregatesResponse {
  results?: unknown;
}

export function toPolygonRange(timeframe: string): { multiplier: number; timespan: string } {
  const match = /^(\d+)([mhd])$/.exec(timeframe);
  if (!match) {
    throw new Error(`PolygonBarsClient: unsupported timeframe '${timeframe}'`);
  }
  const [, countText, unit] = match;
  const timespan = unit === 'm' ? 'minute' : unit === 'h' ? 'hour' : 'day';
  // biome-ignore lint/style/noNonNullAssertion: countText is constrained to \d+ by the regex.
  return { multiplier: Number(countText!), timespan };
}

export interface PolygonBarsClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  rateLimiter?: TokenBucket | undefined;
  retry?: RetryConfig;
}

export class PolygonBarsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly rateLimiter: TokenBucket | undefined;
  private readonly retry: RetryConfig;

  constructor(options: PolygonBarsClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.POLYGON_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'PolygonBarsClient: POLYGON_API_KEY is not set. Provide it via the environment ' +
          '(.env.local, already provisioned) or pass { apiKey } explicitly.',
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rateLimiter = options.rateLimiter;
    this.retry = options.retry ?? DEFAULT_RETRY_CONFIG;
  }

  async getBars(symbol: string, timeframe: string, asOf: Date, limit: number): Promise<Bar[]> {
    if (limit <= 0) return [];

    const { multiplier, timespan } = toPolygonRange(timeframe);
    const requestCount = limit * REQUEST_BUFFER_MULTIPLIER;
    const minBufferMs = isDailyTimeframe(timeframe) ? MIN_DAILY_BUFFER_MS : 0;
    const bufferMs = Math.max(timeframeToMs(timeframe) * requestCount, minBufferMs);
    const from = new Date(asOf.getTime() - bufferMs);

    const params = new URLSearchParams({
      adjusted: 'false',
      sort: 'asc',
      limit: String(PAGE_LIMIT),
    });
    const url =
      `${this.baseUrl}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/` +
      `${toPolygonDate(from)}/${toPolygonDate(asOf)}?${params.toString()}`;

    const context = `${symbol} ${timeframe} bars`;

    const response = await withRetry(
      async () => {
        await this.rateLimiter?.acquireBackground();
        let attempt: Response;
        try {
          attempt = await fetchWithTimeout(
            url,
            { headers: { Authorization: `Bearer ${this.apiKey}` } },
            this.timeoutMs,
          );
        } catch (cause) {
          throw classifyPolygonBarsNetworkError(cause, context);
        }
        if (!attempt.ok) {
          throw classifyPolygonBarsResponse(attempt, context);
        }
        return attempt;
      },
      this.retry,
      isRetryablePolygonBarsError,
    );

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (cause) {
      throw new Error(
        `PolygonBarsClient: response body for ${symbol} ${timeframe} could not be parsed as JSON.`,
        { cause },
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(
        `PolygonBarsClient: malformed response for ${symbol} ${timeframe} — expected an object, ` +
          `got ${truncateForError(JSON.stringify(parsed))}`,
      );
    }
    const body = parsed as PolygonAggregatesResponse;
    if (body.results !== undefined && !Array.isArray(body.results)) {
      throw new Error(
        `PolygonBarsClient: malformed 'results' for ${symbol} ${timeframe} — expected an array.`,
      );
    }
    const rawResults: unknown[] = Array.isArray(body.results) ? body.results : [];

    const bars: Bar[] = rawResults
      .map((raw) => validateRawPolygonAggregate(raw, symbol, 'PolygonBarsClient'))
      .map((agg): Bar => {
        const open_time = new Date(agg.t);
        return {
          instrument: symbol,
          timeframe,
          open_time,
          close_time: closeTimeOf(open_time, timeframe),
          open: agg.o,
          high: agg.h,
          low: agg.l,
          close: agg.c,
          volume: agg.v,
          source: 'polygon',
        };
      })
      .filter((bar) => bar.close_time.getTime() <= asOf.getTime())
      .sort((a, b) => a.close_time.getTime() - b.close_time.getTime());

    return bars.slice(-limit);
  }
}
