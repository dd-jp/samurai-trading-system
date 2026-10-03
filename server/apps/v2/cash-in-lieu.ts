import type {
  BrokerCashInLieu,
  BrokerCashInLieuReader,
  MarketData,
} from '../../../contracts/index.js';
import type { Logger } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import { addDays, fillFxOf } from './data/index.js';
import type { Journal } from './journal/index.js';
import { CASH_IN_LIEU_PAIRING_DAYS } from './tax-cash-in-lieu.js';

// An estimate older than this stops prompting a read; a payment that late is left to the
// accountant against the flagged latest-close estimate
export const CASH_IN_LIEU_LOOKBACK_DAYS = 90;

export interface CashInLieuReadDeps {
  readonly cashInLieu?: BrokerCashInLieuReader | undefined;
  readonly journal: Journal;
  readonly market: Pick<MarketData, 'gbpUsdAtYearStart' | 'gbpUsdYearStartFixDate'>;
  readonly logger?: Logger | undefined;
}

async function readSince(
  deps: CashInLieuReadDeps,
  reader: BrokerCashInLieuReader,
  tradingDate: string,
): Promise<readonly BrokerCashInLieu[] | undefined> {
  const earliest = deps.journal.earliestCashInLieuEstimate(
    reader.venue,
    addDays(tradingDate, -CASH_IN_LIEU_LOOKBACK_DAYS),
  );
  if (earliest === undefined) return [];
  try {
    return await reader.read(addDays(earliest, -CASH_IN_LIEU_PAIRING_DAYS));
  } catch (error) {
    deps.logger?.log({
      trace_id: `v2-${tradingDate}`,
      stage: 'v2',
      level: 'warn',
      event: 'v2_cash_in_lieu_read_failed',
      message: `${reader.venue} cash-in-lieu read failed; the tax log keeps the latest-close estimate: ${describeThrownSafely(error)}`,
    });
    return undefined;
  }
}

// The journal row is the record of the read: the cycle never consumes it, so a replayed day
// reads nothing and the tax log rebuilds from the same rows
export async function readBrokerCashInLieu(
  deps: CashInLieuReadDeps,
  tradingDate: string,
): Promise<number> {
  const reader = deps.cashInLieu;
  if (reader === undefined) return 0;
  const rows = await readSince(deps, reader, tradingDate);
  if (rows === undefined) return 0;
  const fx = fillFxOf(deps.market, reader.venue, tradingDate);
  let added = 0;
  for (const row of rows) {
    const recorded = deps.journal.recordCashInLieu({
      venue: reader.venue,
      activity_id: row.activity_id,
      instrument: row.instrument,
      activity_date: row.activity_date,
      qty: row.qty,
      amount_native: row.amount,
      currency: row.currency,
      fx_quote_per_gbp: fx.quotePerGbp,
      fx_source: fx.source,
      trading_date: tradingDate,
    });
    if (!recorded) continue;
    added += 1;
    deps.logger?.log({
      trace_id: `v2-${tradingDate}`,
      stage: 'v2',
      level: 'info',
      event: 'v2_cash_in_lieu_read',
      message: `${reader.venue} paid ${row.amount} ${row.currency} cash in lieu of ${row.qty ?? 'unstated'} ${row.instrument} on ${row.activity_date} (activity ${row.activity_id}); the tax log uses it in place of the latest-close estimate`,
    });
  }
  return added;
}
