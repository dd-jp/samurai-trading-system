import type { MarketData } from '../../../contracts/index.js';
import { addDays, type EodhdExchange } from './data/index.js';
import type { CfdDividendFeed } from './dividend-feed.js';

export interface BacktestDividends {
  readonly feed: CfdDividendFeed;
  // Every CFD name the run can hold; the caller owns that it is a superset
  readonly names: ReadonlyMap<string, EodhdExchange>;
}

export interface DividendCoverageInput {
  readonly market: Pick<MarketData, 'lastBarBefore'>;
  readonly from: string;
  readonly to: string;
  readonly dividends: BacktestDividends;
}

export function coverageAfter(
  market: Pick<MarketData, 'lastBarBefore'>,
  instrument: string,
  from: string,
): string {
  return market.lastBarBefore(instrument, from)?.date ?? addDays(from, -1);
}

// postmortem §2: the first cycle books the ex-dates after the bar before the window opens, the
// last books none past the window's end
export function assertDividendHistoryCovers(input: DividendCoverageInput): void {
  const gaps = [...input.dividends.names].flatMap(([instrument, exchange]) => {
    const after = coverageAfter(input.market, instrument, input.from);
    const across = input.dividends.feed.across(instrument, exchange, { after, through: input.to });
    if (across.kind === 'covered') return [];
    return [
      across.kind === 'uncovered'
        ? `${instrument} from ${across.from}`
        : `${instrument} disagrees on ${across.date}`,
    ];
  });
  if (gaps.length > 0) {
    throw new Error(
      `backtest: the stored CFD dividend history does not cover ${input.from} to ${input.to} for ${gaps.join(', ')}; fill it before a counted run (#2143)`,
    );
  }
}
