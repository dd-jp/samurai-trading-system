import type { MarketData, Sleeve } from '../../../contracts/index.js';
import { addDays, type EodhdExchange } from './data/index.js';
import type { CfdDividendFeed } from './dividend-feed.js';

export interface BacktestDividends {
  readonly feed: CfdDividendFeed;
  readonly cfdExchangeOf: (instrument: string) => EodhdExchange | undefined;
}

export interface DividendCoverageInput {
  readonly market: Pick<MarketData, 'lastBarBefore'>;
  readonly from: string;
  readonly to: string;
  readonly dividends: BacktestDividends;
}

// Every name a sleeve can enter on any session that has a CFD line; a broader list costs one
// more history read, a missed one fails a cycle after the trial is already counted
export function cfdNamesInUniverse(
  sleeves: readonly Sleeve[],
  dates: readonly string[],
  today: { current: string },
  cfdExchangeOf: BacktestDividends['cfdExchangeOf'],
): ReadonlyMap<string, EodhdExchange> {
  const names = new Map<string, EodhdExchange>();
  const opening = today.current;
  for (const tradingDate of dates) {
    today.current = tradingDate;
    for (const sleeve of sleeves) {
      const context = { tradingDate, macroDay: false, dryRun: true };
      for (const instrument of sleeve.universe(context).instruments) {
        const exchange = cfdExchangeOf(instrument);
        if (exchange !== undefined) names.set(instrument, exchange);
      }
    }
  }
  today.current = opening;
  return names;
}

// postmortem §2: the first cycle books the ex-dates after the bar before the window opens, the
// last books none past the window's end
export function assertDividendHistoryCovers(
  input: DividendCoverageInput,
  names: ReadonlyMap<string, EodhdExchange>,
): void {
  const gaps = [...names].flatMap(([instrument, exchange]) => {
    const after =
      input.market.lastBarBefore(instrument, input.from)?.date ?? addDays(input.from, -1);
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
