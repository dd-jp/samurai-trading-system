import type { Clock } from '../../shared/index.js';
import type { CfdDividendSource, DividendWindow } from './cfd-dividends.js';
import {
  addDays,
  type DividendsRead,
  dividendsAcross,
  type EodhdExchange,
  EodhdRequestError,
  eodhdSymbol,
  type SplitsWindow,
  type SqliteDividendReads,
  ukStockTidm,
} from './data/index.js';

export interface DividendRequest extends DividendWindow {
  readonly instrument: string;
  readonly exchange: EodhdExchange;
}

export interface CfdDividendFeed extends CfdDividendSource {
  refresh(requests: readonly DividendRequest[]): Promise<void>;
}

export interface DividendsReader {
  dividends(symbol: string, window: SplitsWindow): Promise<DividendsRead>;
}

// A UK stock is keyed by its TIDM and _XLON in the store and the router; EODHD knows it by TIDM
export function dividendSymbol(instrument: string, exchange: EodhdExchange): string {
  return eodhdSymbol(ukStockTidm(instrument), exchange);
}

export function dividendReadFailure(error: unknown): string {
  return error instanceof EodhdRequestError ? error.reason : 'unexpected_error';
}

function journalledAcross(reads: SqliteDividendReads, tradingDate: string): CfdDividendSource {
  return {
    across: (instrument, exchange, window) =>
      dividendsAcross(
        reads.cycleReads(dividendSymbol(instrument, exchange), tradingDate),
        window.after,
        window.through,
      ),
  };
}

function covered(
  reads: SqliteDividendReads,
  symbol: string,
  tradingDate: string,
  from: string,
): boolean {
  return reads.cycleReads(symbol, tradingDate).some((read) => read.from <= from);
}

export interface LiveDividendFeedDeps {
  readonly eodhd: DividendsReader;
  readonly reads: SqliteDividendReads;
  readonly clock: Clock;
}

// The cycle on T reads the bars before T, so a read made on T covers every ex-date it can book
export function liveDividendFeed(deps: LiveDividendFeedDeps, tradingDate: string): CfdDividendFeed {
  const fetchOne = async (symbol: string, window: SplitsWindow): Promise<void> => {
    if (covered(deps.reads, symbol, tradingDate, window.from)) return;
    try {
      const read = await deps.eodhd.dividends(symbol, window);
      deps.reads.recordRead('cycle', tradingDate, read, deps.clock.now());
    } catch (error) {
      const failed = { symbol, ...window, reason: dividendReadFailure(error) };
      deps.reads.recordFailure('cycle', tradingDate, failed, deps.clock.now());
    }
  };
  return {
    ...journalledAcross(deps.reads, tradingDate),
    async refresh(requests) {
      for (const request of requests) {
        const symbol = dividendSymbol(request.instrument, request.exchange);
        await fetchOne(symbol, { from: addDays(request.after, 1), to: addDays(tradingDate, -1) });
      }
    },
  };
}

// Replay answers only from the journal: a day with no dividend read ran without the feed
export function journalledDividendFeed(
  reads: SqliteDividendReads,
  tradingDate: string,
): CfdDividendFeed | undefined {
  if (!reads.anyCycleReadOn(tradingDate)) return undefined;
  return { ...journalledAcross(reads, tradingDate), refresh: () => Promise.resolve() };
}

export function historyDividendFeed(reads: SqliteDividendReads): CfdDividendFeed {
  const bySymbol = new Map<string, readonly DividendsRead[]>();
  const historyOf = (symbol: string) => {
    const cached = bySymbol.get(symbol) ?? reads.historyReads(symbol);
    bySymbol.set(symbol, cached);
    return cached;
  };
  return {
    across: (instrument, exchange, window) =>
      dividendsAcross(
        historyOf(dividendSymbol(instrument, exchange)),
        window.after,
        window.through,
      ),
    refresh: () => Promise.resolve(),
  };
}
