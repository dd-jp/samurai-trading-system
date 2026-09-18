import type { TradingCalendar } from '../../../providers/market-data-service/index.js';

export function withFlattenTail(
  entryWindow: (instant: Date) => boolean,
  calendar: TradingCalendar,
  flattenBeforeCloseMs: number,
): (instant: Date) => boolean {
  return (instant: Date): boolean => {
    if (entryWindow(instant)) {
      return true;
    }

    const sessionEnd = calendar.sessionEnd(instant);
    if (sessionEnd === null) {
      return false;
    }

    const remaining = sessionEnd.getTime() - instant.getTime();
    return remaining >= 0 && remaining <= flattenBeforeCloseMs;
  };
}

export function postCloseFlattenTail(
  calendar: TradingCalendar,
  flattenAfterCloseMs: number,
): (instant: Date) => boolean {
  return (instant: Date): boolean => {
    if (calendar.sessionEnd(instant) === null) return false;

    const elapsed = instant.getTime() - calendar.sessionStart(instant).getTime();
    return elapsed >= 0 && elapsed <= flattenAfterCloseMs;
  };
}
