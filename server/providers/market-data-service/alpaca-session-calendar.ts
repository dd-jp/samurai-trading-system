import type { RetryConfig } from '../../shared/index.js';
import {
  describeThrownSafely,
  fetchWithTimeout,
  isServerErrorStatus,
  truncateForError,
  withRetry,
} from '../../shared/index.js';
import type { TradingCalendar } from './trading-calendar.js';
import {
  civilDateKey,
  ET_ZONE,
  MAX_SESSION_SEARCH_DAYS,
  nextCivilDay,
  previousCivilDay,
  toCivilDate,
  toZonedTime,
  wallClockToInstant,
  type ZonedCivilDate,
} from './trading-calendar.js';

export interface AlpacaCalendarDay {
  date: string;
  open: string;
  close: string;
}

export interface AlpacaCalendarClient {
  fetchCalendar(range: { start: string; end: string }): Promise<AlpacaCalendarDay[]>;
}

export class AlpacaCalendarFetchError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'AlpacaCalendarFetchError';
    this.retryable = retryable;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_CONFIG: RetryConfig = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 };
const DEFAULT_BASE_URL = 'https://paper-api.alpaca.markets';

export interface AlpacaCalendarClientOptions {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  timeoutMs?: number;
  retry?: RetryConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateAlpacaCalendarDays(body: unknown, context: string): AlpacaCalendarDay[] {
  if (!Array.isArray(body)) {
    throw new AlpacaCalendarFetchError(
      `Alpaca calendar response was not an array (${context}): ${truncateForError(JSON.stringify(body))}`,
      false,
    );
  }
  return body.map((raw, index) => {
    if (
      !isRecord(raw) ||
      typeof raw.date !== 'string' ||
      typeof raw.open !== 'string' ||
      typeof raw.close !== 'string'
    ) {
      throw new AlpacaCalendarFetchError(
        `Alpaca calendar row ${index} is malformed (${context}): expected {date, open, close} ` +
          `strings, got ${truncateForError(JSON.stringify(raw))}`,
        false,
      );
    }
    return { date: raw.date, open: raw.open, close: raw.close };
  });
}

async function classifyCalendarResponseError(
  response: Response,
  context: string,
): Promise<AlpacaCalendarFetchError> {
  let bodyText = '';
  try {
    bodyText = truncateForError(await response.text());
  } catch {}
  return new AlpacaCalendarFetchError(
    `Alpaca calendar request failed (${context}): ${response.status} ` +
      `${response.statusText} ${bodyText}`,
    response.status === 429 || isServerErrorStatus(response.status),
  );
}

export class AlpacaHttpCalendarClient implements AlpacaCalendarClient {
  readonly #apiKey: string;
  readonly #apiSecret: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #retry: RetryConfig;

  constructor(options: AlpacaCalendarClientOptions = {}) {
    const fromEnv = (name: string): string | undefined => {
      const value = process.env[name]?.trim();
      return value === undefined || value.length === 0 ? undefined : value;
    };
    const apiKey = options.apiKey ?? fromEnv('ALPACA_API_KEY');
    const apiSecret = options.apiSecret ?? fromEnv('ALPACA_API_SECRET');
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'AlpacaHttpCalendarClient: ALPACA_API_KEY is not set. Provide it via the environment ' +
          '(.env.local) or pass { apiKey } explicitly — the paper account pair, shared with the ' +
          'market-data client (per Alpaca public docs, one paper key pair covers both Trading ' +
          'and Market Data APIs).',
      );
    }
    if (apiSecret === undefined || apiSecret.length === 0) {
      throw new Error(
        'AlpacaHttpCalendarClient: ALPACA_API_SECRET is not set. Provide it via the environment ' +
          '(.env.local) or pass { apiSecret } explicitly.',
      );
    }
    this.#apiKey = apiKey;
    this.#apiSecret = apiSecret;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retry = options.retry ?? DEFAULT_RETRY_CONFIG;
  }

  async fetchCalendar(range: { start: string; end: string }): Promise<AlpacaCalendarDay[]> {
    const url = `${this.#baseUrl}/v2/calendar?start=${range.start}&end=${range.end}`;
    const context = `GET /v2/calendar ${range.start}..${range.end}`;

    return withRetry<AlpacaCalendarDay[]>(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(
            url,
            {
              headers: {
                'APCA-API-KEY-ID': this.#apiKey,
                'APCA-API-SECRET-KEY': this.#apiSecret,
              },
            },
            this.#timeoutMs,
          );
        } catch (cause) {
          throw new AlpacaCalendarFetchError(
            `network error fetching Alpaca calendar (${context}): ` +
              `${describeThrownSafely(cause)}`,
            true,
          );
        }

        if (!response.ok) {
          throw await classifyCalendarResponseError(response, context);
        }

        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch (cause) {
          throw new AlpacaCalendarFetchError(
            `Alpaca calendar response body could not be parsed as JSON (${context}): ` +
              `${cause instanceof Error ? cause.message : String(cause)}`,
            false,
          );
        }

        return validateAlpacaCalendarDays(parsed, context);
      },
      this.#retry,
      (error) => error instanceof AlpacaCalendarFetchError && error.retryable,
    );
  }
}

export interface AlpacaSessionRow {
  openMinutes: number;
  closeMinutes: number;
}

function parseWallClockMinutes(value: string, field: 'open' | 'close', date: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error(
      `buildAlpacaSessionTable: ${field} '${value}' for ${date} is not HH:MM — Alpaca's ` +
        'calendar wire format is expected to be a zero-padded 24-hour ET wall-clock time.',
    );
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`buildAlpacaSessionTable: ${field} '${value}' for ${date} is out of range.`);
  }
  return hour * 60 + minute;
}

export function buildAlpacaSessionTable(
  days: readonly AlpacaCalendarDay[],
): Map<string, AlpacaSessionRow> {
  const table = new Map<string, AlpacaSessionRow>();
  for (const day of days) {
    const openMinutes = parseWallClockMinutes(day.open, 'open', day.date);
    const closeMinutes = parseWallClockMinutes(day.close, 'close', day.date);
    if (!(openMinutes < closeMinutes)) {
      throw new Error(
        `buildAlpacaSessionTable: ${day.date} has open (${day.open}) >= close (${day.close}).`,
      );
    }
    table.set(day.date, { openMinutes, closeMinutes });
  }
  return table;
}

export class AlpacaEquitySessionCalendar implements TradingCalendar {
  readonly #table: ReadonlyMap<string, AlpacaSessionRow>;

  constructor(table: ReadonlyMap<string, AlpacaSessionRow>) {
    this.#table = table;
  }

  isTradingDay(instant: Date): boolean {
    return this.#table.has(civilDateKey(toCivilDate(instant, ET_ZONE)));
  }

  isOpen(instant: Date): boolean {
    const row = this.#table.get(civilDateKey(toCivilDate(instant, ET_ZONE)));
    if (row === undefined) return false;

    const { minutesSinceMidnight } = toZonedTime(instant, ET_ZONE);
    return minutesSinceMidnight >= row.openMinutes && minutesSinceMidnight < row.closeMinutes;
  }

  sessionEnd(instant: Date): Date | null {
    let civilDate: ZonedCivilDate = toCivilDate(instant, ET_ZONE);

    for (let day = 0; day <= MAX_SESSION_SEARCH_DAYS; day++) {
      const row = this.#table.get(civilDateKey(civilDate));
      if (row !== undefined) {
        const close = wallClockToInstant(civilDate, row.closeMinutes, ET_ZONE);
        if (close.getTime() > instant.getTime()) return close;
      }
      civilDate = nextCivilDay(civilDate);
    }

    throw new Error(
      `AlpacaEquitySessionCalendar: no session close found within ${MAX_SESSION_SEARCH_DAYS} ` +
        `days after ${instant.toISOString()} — the fetched Alpaca calendar table may not cover ` +
        'this far forward.',
    );
  }

  sessionStart(instant: Date): Date {
    let civilDate: ZonedCivilDate = toCivilDate(instant, ET_ZONE);

    for (let day = 0; day <= MAX_SESSION_SEARCH_DAYS; day++) {
      const row = this.#table.get(civilDateKey(civilDate));
      if (row !== undefined) {
        const close = wallClockToInstant(civilDate, row.closeMinutes, ET_ZONE);
        if (close.getTime() <= instant.getTime()) return close;
      }
      civilDate = previousCivilDay(civilDate);
    }

    throw new Error(
      `AlpacaEquitySessionCalendar: no session close found within ${MAX_SESSION_SEARCH_DAYS} ` +
        `days before ${instant.toISOString()} — the fetched Alpaca calendar table may not cover ` +
        'this far back.',
    );
  }
}
