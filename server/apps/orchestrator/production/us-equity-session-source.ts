/**
 * Resolves the US equity session calendar the paper leg boots on (#684) —
 * fetches Alpaca's `GET /v2/calendar`, falls back loudly to the hand-entered
 * table on failure. The ONLY caller is the CLI entrypoint guard in
 * `index.ts` (the `if (... import.meta.url === pathToFileURL(...).href)`
 * block), NOT `startFromEnvironment` itself — deliberately: `startFromEnvironment`
 * is called directly, with no `fetch` stub, by dozens of existing tests
 * (`startup.test.ts` among them), so awaiting a live Alpaca fetch inside its
 * body would turn every one of those into a real outbound network call. The
 * CLI guard resolves this calendar and passes it in as `tradingCalendar` on
 * the options object handed to `startFromEnvironment`, which spreads
 * `injected` wholesale into `buildProductionOrchestrator` — so the
 * composition root itself stays synchronous and untouched; only the actual
 * `npm run orchestrator` process ever awaits this.
 *
 * See `calendar-fallback-alert.ts` for the fetch-failure decision this
 * module implements: fetch at startup; on failure, alert loudly and fall
 * back to `UsEquityRegularHoursCalendar` rather than refusing to boot.
 * Refusing was rejected because it couples a 14-day unattended paper soak's
 * availability to one network call succeeding at exactly the moment it is
 * made; falling back SILENTLY was rejected because it is indistinguishable
 * from a healthy run from outside (#625/#691's signature). This is neither:
 * the operator is paged, and the fallback table itself still throws rather
 * than guessing past its own coverage cliff (`US_TABLE_COVERAGE_END`,
 * trading-calendar.ts) — so even the degraded path cannot silently take the
 * dangerous direction #684 exists to close.
 *
 * **Live mode is never touched.** The live equity leg is a Saxo Capital
 * Markets UK GIA (ADR-0015, #659; ADR-0015's 2026-08-30 amendment — this
 * comment said "Trading 212 ISA" until #946), not Alpaca, and runs
 * `LseRegularHoursCalendar` — this
 * factory is for the PAPER leg only, matching #684's own scope.
 */

import type {
  AlpacaCalendarClient,
  TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import {
  AlpacaEquitySessionCalendar,
  AlpacaHttpCalendarClient,
  buildAlpacaSessionTable,
  US_TABLE_COVERAGE_END,
  UsEquityRegularHoursCalendar,
} from '../../../providers/market-data-service/index.js';
// Reached directly rather than through the barrel: these are the internal
// Eastern-civil-date helpers `trading-calendar.ts` exports for exactly this
// caller (see `ET_ZONE`'s own doc comment) — not part of the package's public
// surface, so they stay off `providers/market-data-service/index.ts`
import {
  civilDateKey,
  ET_ZONE,
  toCivilDate,
  type ZonedCivilDate,
} from '../../../providers/market-data-service/trading-calendar.js';
import { loggingAlertChannel } from '../alert-catalogue.js';
import type { Logger } from '../types.js';
import type { CalendarFallbackAlertChannel } from './calendar-fallback-alert.js';

/** How far back/forward the fetched table reaches, in civil days from `now` */
const CALENDAR_FETCH_LOOKBACK_DAYS = 30;
/**
 * ~13 months forward. Generous on purpose: `sessionEnd`/`sessionStart` walk
 * at most `MAX_SESSION_SEARCH_DAYS` (10) days from `now`, so this window's
 * real job is surviving a long-running process without a restart — a 14-day
 * soak needs a fraction of this, and the table costs nothing extra to fetch
 * wide (one HTTP round trip, a few hundred small rows).
 */
const CALENDAR_FETCH_LOOKAHEAD_DAYS = 400;

function addCivilDays(date: ZonedCivilDate, days: number): string {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000);
  return civilDateKey({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

export interface ResolveUsEquitySessionCalendarOptions {
  logger: Logger;
  now: () => Date;
  /** Injected in tests — no real network call otherwise. Defaults to `AlpacaHttpCalendarClient`. */
  client?: AlpacaCalendarClient;
  /** Defaults to `loggingAlertChannel('calendarFallbackAlerts', logger)`, same posture as `dataFailoverAlerts` */
  alertChannel?: CalendarFallbackAlertChannel;
}

/**
 * Fetches the live table and returns `AlpacaEquitySessionCalendar`, or — on
 * ANY failure (network, malformed response, missing credentials) — logs and
 * alerts at `error`, then returns `new UsEquityRegularHoursCalendar()`.
 *
 * Never throws: a calendar this process cannot resolve is exactly the
 * boot-blocking failure the fetch-vs-refuse decision rejected refusing on.
 * The one case where the caller should NOT reach this at all is `mode ===
 * 'live'` — see the module doc.
 */
export async function resolveUsEquitySessionCalendar(
  options: ResolveUsEquitySessionCalendarOptions,
): Promise<TradingCalendar> {
  const { logger, now } = options;
  const alertChannel =
    options.alertChannel ?? loggingAlertChannel('calendarFallbackAlerts', logger);

  const fallback = (reason: string): TradingCalendar => {
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      event: 'calendar_fetch_failed',
      level: 'error',
      message:
        "paper equity leg's Alpaca GET /v2/calendar fetch failed at boot: " +
        `${reason} — falling back to the hand-entered US equity session table ` +
        `(checked through ${US_TABLE_COVERAGE_END}). The run continues; restart to re-fetch ` +
        'the live table.',
      payload: { fallback_coverage_end: US_TABLE_COVERAGE_END },
    });
    alertChannel.postCalendarFallbackAlert({
      reason,
      fallback_coverage_end: US_TABLE_COVERAGE_END,
      reported_at: now(),
    });
    return new UsEquityRegularHoursCalendar();
  };

  let client: AlpacaCalendarClient;
  try {
    client = options.client ?? new AlpacaHttpCalendarClient();
  } catch (error) {
    // Missing/empty ALPACA_API_KEY/SECRET — a construction-time throw, not a
    // fetch error, but the same fallback applies: this process already
    // refuses to boot ahead of this point if the paper Alpaca pair is wholly
    // absent (`assertCredentialsPresent`, index.ts), so reaching this catch
    // means the pair passed that gate but this client's own construction
    // still failed (e.g. a caller-injected empty override) — treat it exactly
    // like a fetch failure rather than letting it escape uncaught
    return fallback(error instanceof Error ? error.message : String(error));
  }

  const today = toCivilDate(now(), ET_ZONE);
  const start = addCivilDays(today, -CALENDAR_FETCH_LOOKBACK_DAYS);
  const end = addCivilDays(today, CALENDAR_FETCH_LOOKAHEAD_DAYS);

  try {
    const days = await client.fetchCalendar({ start, end });
    const table = buildAlpacaSessionTable(days);
    if (table.size === 0) {
      // An empty table is not a network failure — Alpaca answered — but a
      // calendar with zero known trading days answers every `isTradingDay`
      // `false` and can never flatten anything, which is a worse silent
      // failure than falling back. Treated the same as any other failure.
      throw new Error(`Alpaca returned zero calendar rows for ${start}..${end}`);
    }
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      level: 'info',
      message: "paper equity leg's US session calendar sourced from Alpaca GET /v2/calendar",
      payload: { start, end, days: table.size },
    });
    return new AlpacaEquitySessionCalendar(table);
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error));
  }
}
