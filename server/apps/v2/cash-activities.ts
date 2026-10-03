import type {
  BrokerCashActivity,
  BrokerCashActivityReader,
  BrokerMode,
  Venue,
} from '../../../contracts/index.js';
import type { Logger } from '../../shared/index.js';
import { describeThrownSafely, logIfPresent } from '../../shared/index.js';
import type { CashAnchor, CashAnchorLedger } from './cash-anchor.js';
import { addDays } from './data/index.js';

// A status change older than this is not re-read; the cash check then shows it as a gap
export const CASH_ACTIVITY_LOOKBACK_DAYS = 90;

type ActivityLedger = Pick<CashAnchorLedger, 'anchor' | 'recordActivity'>;

export interface CashActivityReadDeps {
  readonly cashActivities?: BrokerCashActivityReader | undefined;
  readonly cashAnchors?: ActivityLedger | undefined;
  readonly brokerMode: BrokerMode;
  readonly logger?: Logger | undefined;
}

// Activities carry a date, not a time: one dated on the anchor's own day is taken as already in the
// anchor's cash
async function readSince(
  reader: BrokerCashActivityReader,
  anchor: CashAnchor,
  tradingDate: string,
): Promise<readonly BrokerCashActivity[]> {
  const lookback = addDays(tradingDate, -CASH_ACTIVITY_LOOKBACK_DAYS);
  const since = lookback > anchor.tradingDate ? lookback : anchor.tradingDate;
  const rows = await reader.read(since);
  return rows.filter((row) => row.activity_date > anchor.tradingDate);
}

function journalRows(
  deps: CashActivityReadDeps,
  ledger: ActivityLedger,
  venue: Venue,
  rows: readonly BrokerCashActivity[],
  tradingDate: string,
): number {
  let added = 0;
  for (const row of rows) {
    if (!ledger.recordActivity(venue, deps.brokerMode, row, tradingDate)) continue;
    added += 1;
    logIfPresent(deps.logger, {
      trace_id: `v2-${tradingDate}`,
      stage: 'v2',
      level: 'info',
      event: 'v2_cash_activity_read',
      message: `${venue} reported ${row.activity_type} ${row.amount} on ${row.activity_date} (activity ${row.activity_id}, ${row.status}); journalled as a cash anchor move`,
    });
  }
  return added;
}

// David 2026-10-03 (#2035 item 5): read before the cash check so the gap holds only trade-related
// drift. The journal row is the record of the read, so a replayed day builds no reader
export async function readBrokerCashActivities(
  deps: CashActivityReadDeps,
  tradingDate: string,
): Promise<number> {
  const reader = deps.cashActivities;
  const ledger = deps.cashAnchors;
  if (reader === undefined || ledger === undefined) return 0;
  try {
    const anchor = ledger.anchor(reader.venue);
    if (anchor === undefined || anchor.brokerMode !== deps.brokerMode) return 0;
    const rows = await readSince(reader, anchor, tradingDate);
    return journalRows(deps, ledger, reader.venue, rows, tradingDate);
  } catch (error) {
    logIfPresent(deps.logger, {
      trace_id: `v2-${tradingDate}`,
      stage: 'v2',
      level: 'warn',
      event: 'v2_cash_activity_read_failed',
      message: `${reader.venue} non-trade cash read failed; the cash check runs on the moves already journalled: ${describeThrownSafely(error)}`,
    });
    return 0;
  }
}
