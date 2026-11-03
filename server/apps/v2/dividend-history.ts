import type { MarketData } from '../../../contracts/index.js';
import type { Clock } from '../../shared/index.js';
import { coverageAfter } from './backtest-dividends.js';
import { addDays, type EodhdExchange, type SqliteDividendReads } from './data/index.js';
import {
  type DividendsReader,
  dividendReadFailure,
  dividendSymbol,
  historyDividendFeed,
} from './dividend-feed.js';

export interface DividendHistoryDeps {
  readonly eodhd: DividendsReader;
  readonly reads: SqliteDividendReads;
  readonly clock: Clock;
  readonly market: Pick<MarketData, 'lastBarBefore'>;
}

export interface DividendHistoryReport {
  readonly fetched: readonly string[];
  readonly held: readonly string[];
  readonly failed: readonly { readonly symbol: string; readonly reason: string }[];
}

// A read made today vouches only through yesterday
export async function fillDividendHistory(
  deps: DividendHistoryDeps,
  names: ReadonlyMap<string, EodhdExchange>,
  window: { readonly from: string; readonly to: string },
): Promise<DividendHistoryReport> {
  const stored = historyDividendFeed(deps.reads);
  const today = deps.clock.now().toISOString().slice(0, 10);
  const report = {
    fetched: [] as string[],
    held: [] as string[],
    failed: [] as DividendHistoryReport['failed'][number][],
  };
  for (const [instrument, exchange] of names) {
    const symbol = dividendSymbol(instrument, exchange);
    const after = coverageAfter(deps.market, instrument, window.from);
    if (stored.across(instrument, exchange, { after, through: window.to }).kind === 'covered') {
      report.held.push(symbol);
      continue;
    }
    const asked = { from: addDays(after, 1), to: addDays(today, -1) };
    try {
      const read = await deps.eodhd.dividends(symbol, asked);
      deps.reads.recordRead('history', today, read, deps.clock.now());
      report.fetched.push(symbol);
    } catch (error) {
      const reason = dividendReadFailure(error);
      deps.reads.recordFailure('history', today, { symbol, ...asked, reason }, deps.clock.now());
      report.failed.push({ symbol, reason });
    }
  }
  return report;
}
