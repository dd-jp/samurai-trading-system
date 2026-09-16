/**
 * The US equity session table sourced from Alpaca's own `GET /v2/calendar`
 * (#684), replacing the hand-entered `US_HOLIDAYS`/`US_EARLY_CLOSE_DAYS` in
 * `trading-calendar.ts` for the paper equity leg.
 *
 * ## Why
 *
 * `UsEquityRegularHoursCalendar` decides when the paper equity book must be
 * flat (#668), not just when to ingest bars. Its hand-entered tables are
 * partial by construction — `US_EARLY_CLOSE_DAYS` only carries the Fridays
 * after Thanksgiving and the Christmas Eves someone thought to type in, and
 * coverage stops at 2027. A missing early close is the DANGEROUS direction:
 * the flatten computes for 16:00 ET on a market that shut at 13:00, and the
 * position sits unflattened through the close — the overnight carry
 * ADR-0014 forbids. Alpaca's calendar endpoint is the venue's own session
 * table: one row per trading date with its actual open/close, early closes
 * included, no rule-inference and no coverage cliff.
 *
 * ## What this module is, and is not
 *
 * A pure calendar-and-client pair, with no dependency on the orchestrator's
 * alert machinery. `AlpacaEquitySessionCalendar` implements the same
 * `TradingCalendar` port `UsEquityRegularHoursCalendar` does, built from a
 * table this module knows how to fetch and validate but does not decide
 * WHAT TO DO on a fetch failure — that decision (fall back to the hand table
 * and alert loudly, per #684's own resolution) belongs to the composition
 * root, which is the only layer that knows about `Logger`/alert channels.
 * See `server/apps/orchestrator/production/us-equity-session-source.ts`.
 */

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

/**
 * One row of Alpaca's `GET /v2/calendar` response, the fields this module
 * reads. Alpaca also returns `session_open`/`session_close` (the
 * pre/post-market bounds) which nothing here consumes — `open`/`close` are
 * the REGULAR session, the only session `UsEquityRegularHoursCalendar` ever
 * modelled.
 */
export interface AlpacaCalendarDay {
  /** `YYYY-MM-DD`, the trading date — the same key `civilDateKey` produces */
  date: string;
  /** `HH:MM`, ET wall clock — 09:30 on every ordinary day */
  open: string;
  /** `HH:MM`, ET wall clock — 16:00 normally, 13:00 on a known early close */
  close: string;
}

/** The seam the fallback wiring stubs in tests — no real network call there */
export interface AlpacaCalendarClient {
  /** `start`/`end` are `YYYY-MM-DD`, inclusive, in Alpaca's own date format */
  fetchCalendar(range: { start: string; end: string }): Promise<AlpacaCalendarDay[]>;
}

/** Thrown by `AlpacaHttpCalendarClient`. `retryable` drives `withRetry`'s predicate. */
export class AlpacaCalendarFetchError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'AlpacaCalendarFetchError';
    this.retryable = retryable;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Same shape as the broker/data clients' retry budgets (transport-layer-spec.md) */
const DEFAULT_RETRY_CONFIG: RetryConfig = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 };
/** Alpaca's paper trading host — `/v2/calendar` is a Trading API endpoint, not Data API */
const DEFAULT_BASE_URL = 'https://paper-api.alpaca.markets';

export interface AlpacaCalendarClientOptions {
  /** Defaults to `ALPACA_API_KEY` — the paper account's pair (#684 is scoped to the paper leg) */
  apiKey?: string;
  /** Defaults to `ALPACA_API_SECRET` */
  apiSecret?: string;
  /** Defaults to Alpaca's paper trading host. Override only for a mock/staging host in tests. */
  baseUrl?: string;
  timeoutMs?: number;
  retry?: RetryConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validates the wire shape (issue #509's posture, applied here too: this
 * feeds the flatten boundary, so it deserves the same scrutiny the broker
 * client gives fill quantities). A row missing `date`/`open`/`close`, or
 * carrying the wrong type, fails loudly here rather than producing a
 * calendar that silently answers `undefined` for a real trading day.
 */
export function validateAlpacaCalendarDays(body: unknown, context: string): AlpacaCalendarDay[] {
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
  } catch {
    // Best-effort context only; the status is the load-bearing fact
  }
  return new AlpacaCalendarFetchError(
    `Alpaca calendar request failed (${context}): ${response.status} ` +
      `${response.statusText} ${bodyText}`,
    // 429/5xx are transient; a 4xx (bad key, bad params) will not fix itself on retry
    response.status === 429 || isServerErrorStatus(response.status),
  );
}

/**
 * Real HTTP implementation against Alpaca's Trading API, same auth headers
 * and `fetchWithTimeout`/`withRetry` boilerplate as
 * `pipeline/execution/adapters/alpaca-http-client.ts`. A separate,
 * deliberately small client rather than a reuse of the broker one: the
 * broker client's `request<T>` is private and its constructor enforces the
 * live/paper environment guard this client does not need — #684 is scoped to
 * the paper equity leg only, so there is no live host to guard against here.
 */
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
          // Network failure, DNS, timeout — always retryable within budget
          // Guarded render: a throw from it escapes before the retryable
          // AlpacaCalendarFetchError is constructed, so the predicate below
          // sees a plain Error and refuses it. withRetry still runs this
          // first of 3 budgeted attempts, then rethrows immediately instead
          // of spending the other 2 — a transient blip becomes terminal
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

/** One trading day's regular session, in minutes since ET midnight */
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

/**
 * Builds the lookup `AlpacaEquitySessionCalendar` walks, keyed by
 * `civilDateKey`'s `YYYY-MM-DD` — the same key format Alpaca's own `date`
 * field already is, so no reparsing is needed to align the two.
 *
 * Throws on a malformed row (open >= close, an unparsable time) rather than
 * dropping it: a silently-skipped trading day is exactly the "un-modelled
 * date treated as no session" hazard the sessionEnd/sessionStart walk would
 * then paper over by searching past it.
 */
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

/**
 * `TradingCalendar` sourced from Alpaca's `GET /v2/calendar` (#684).
 *
 * Unlike `UsEquityRegularHoursCalendar`, `isTradingDay` needs no separate
 * weekend/holiday logic: Alpaca's calendar lists ONLY trading dates, so
 * `#table.has(key)` already answers "does this civil date have a session" —
 * weekends and holidays alike are simply absent rows, both because Alpaca
 * computed that, not because this class re-derived it.
 *
 * A date outside the fetched window (before `range.start`, or beyond
 * `range.end`) is equally absent, and is treated exactly like a holiday for
 * `isTradingDay`/`isOpen` — the SAFE direction, same reasoning
 * `UsEquityRegularHoursCalendar`'s module doc gives for its own table's
 * cliff: nothing overnight is carried by treating a day this class cannot
 * see as having no session. `sessionStart`/`sessionEnd` walk up to
 * `MAX_SESSION_SEARCH_DAYS` days and throw on exhaustion exactly as the hand
 * table does — the un-modelled-forward-window case #684's factory guards
 * against by fetching generously far ahead (see `us-equity-session-source.ts`).
 */
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
