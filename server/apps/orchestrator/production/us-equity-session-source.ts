
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
import {
  civilDateKey,
  ET_ZONE,
  toCivilDate,
  type ZonedCivilDate,
} from '../../../providers/market-data-service/trading-calendar.js';
import { loggingAlertChannel } from '../alert-catalogue.js';
import type { Logger } from '../types.js';
import type { CalendarFallbackAlertChannel } from './calendar-fallback-alert.js';

const CALENDAR_FETCH_LOOKBACK_DAYS = 30;
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
  client?: AlpacaCalendarClient;
  alertChannel?: CalendarFallbackAlertChannel;
}

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
    return fallback(error instanceof Error ? error.message : String(error));
  }

  const today = toCivilDate(now(), ET_ZONE);
  const start = addCivilDays(today, -CALENDAR_FETCH_LOOKBACK_DAYS);
  const end = addCivilDays(today, CALENDAR_FETCH_LOOKAHEAD_DAYS);

  try {
    const days = await client.fetchCalendar({ start, end });
    const table = buildAlpacaSessionTable(days);
    if (table.size === 0) {
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
