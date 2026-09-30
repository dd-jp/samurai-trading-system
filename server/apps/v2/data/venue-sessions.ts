import type { Venue } from '../../../../contracts/index.js';
import {
  LONDON_ZONE,
  LSE_TABLE_COVERAGE_END,
  LseRegularHoursCalendar,
  US_TABLE_COVERAGE_END,
  UsEquityRegularHoursCalendar,
  wallClockToInstant,
} from '../../../providers/market-data-service/index.js';
import { homeBarVenue } from './venues.js';

export type Exchange = 'us' | 'lse';
export type SessionDay = 'open' | 'closed' | 'uncovered';
export type SitOutCode = 'venue_closed' | 'venue_calendar_uncovered' | 'late_wake_entry_cutoff';

export interface VenueSessionGate {
  entrySitOut(venue: Venue, tradingDate: string, now: Date): SitOutCode | undefined;
  timeStopPausedVenues(tradingDate: string): readonly Venue[];
}

const VENUES: readonly Venue[] = ['alpaca', 'saxo', 'saxo_cfd_gbp', 'saxo_cfd_usd'];

const CALENDARS: Readonly<Record<Exchange, { isTradingDay(instant: Date): boolean }>> = {
  us: new UsEquityRegularHoursCalendar(),
  lse: new LseRegularHoursCalendar(),
};

// isTradingDay reads the hand tables without checking their coverage, so an uncovered weekday
// would pass as open
const COVERAGE_END: Readonly<Record<Exchange, string>> = {
  us: US_TABLE_COVERAGE_END,
  lse: LSE_TABLE_COVERAGE_END,
};

// David 2026-09-30 (#1933): the LSE and US opens as London wall-clock times, DST included
const ENTRY_CUTOFF_LONDON_MINUTES: Readonly<Record<Exchange, number>> = {
  lse: 8 * 60,
  us: 14 * 60 + 30,
};

function civilDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year: year as number, month: month as number, day: day as number };
}

function isWeekend(date: string): boolean {
  const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function exchangeOf(venue: Venue): Exchange {
  return homeBarVenue(venue) === 'alpaca' ? 'us' : 'lse';
}

export function sessionDay(exchange: Exchange, date: string): SessionDay {
  if (isWeekend(date)) return 'closed';
  if (date > COVERAGE_END[exchange]) return 'uncovered';
  return CALENDARS[exchange].isTradingDay(new Date(`${date}T12:00:00.000Z`)) ? 'open' : 'closed';
}

export function bothVenuesClosed(date: string): boolean {
  return sessionDay('us', date) === 'closed' && sessionDay('lse', date) === 'closed';
}

export function entryCutoff(exchange: Exchange, date: string): Date {
  return wallClockToInstant(civilDate(date), ENTRY_CUTOFF_LONDON_MINUTES[exchange], LONDON_ZONE);
}

const SIT_OUT_BY_DAY: Readonly<Record<Exclude<SessionDay, 'open'>, SitOutCode>> = {
  closed: 'venue_closed',
  uncovered: 'venue_calendar_uncovered',
};

export const TABLE_VENUE_SESSIONS: VenueSessionGate = {
  entrySitOut(venue, tradingDate, now) {
    const exchange = exchangeOf(venue);
    const day = sessionDay(exchange, tradingDate);
    if (day !== 'open') return SIT_OUT_BY_DAY[day];
    return now.getTime() >= entryCutoff(exchange, tradingDate).getTime()
      ? 'late_wake_entry_cutoff'
      : undefined;
  },
  timeStopPausedVenues(tradingDate) {
    return VENUES.filter((venue) => sessionDay(exchangeOf(venue), tradingDate) === 'closed');
  },
};
