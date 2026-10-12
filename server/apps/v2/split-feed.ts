import type { Clock } from '../../shared/index.js';
import {
  AlpacaSplitsError,
  addDays,
  type EodhdExchange,
  EodhdRequestError,
  eodhdSymbol,
  type SplitSourceName,
  type SplitsRead,
  type SplitsWindow,
  type SqliteSplitReads,
} from './data/index.js';
import type { SplitCheckLedger, SplitRequest } from './split-checks.js';
import type { SplitSources } from './split-crosscheck.js';

export interface SplitFeed {
  refresh(requests: readonly SplitRequest[], tradingDate: string): Promise<void>;
  sources(instrument: string, exchange: EodhdExchange, tradingDate: string): SplitSources;
  readonly checks: SplitCheckLedger;
}

export interface SplitsReader {
  splits(symbol: string, window: SplitsWindow): Promise<SplitsRead>;
}

export interface SplitFeedDeps {
  readonly eodhd: SplitsReader;
  readonly alpaca: SplitsReader | undefined;
  readonly reads: SqliteSplitReads;
  readonly checks: SplitCheckLedger;
  readonly clock: Clock;
}

interface Fetch {
  readonly source: SplitSourceName;
  readonly reader: SplitsReader | undefined;
  readonly symbol: string;
  readonly window: SplitsWindow;
}

const NO_ALPACA_KEY = 'no_alpaca_key';

function reasonOf(error: unknown): string {
  if (error instanceof EodhdRequestError || error instanceof AlpacaSplitsError) return error.reason;
  return 'unexpected_error';
}

export function mergedWindows(
  requests: readonly SplitRequest[],
  tradingDate: string,
): (SplitsWindow & { readonly instrument: string; readonly exchange: EodhdExchange })[] {
  const earliest = new Map<string, SplitRequest>();
  for (const request of requests) {
    const key = `${request.exchange}:${request.instrument}`;
    const held = earliest.get(key);
    if (held === undefined || request.after < held.after) earliest.set(key, request);
  }
  return [...earliest.values()]
    .map(({ instrument, exchange, after }) => ({
      instrument,
      exchange,
      from: addDays(after, 1),
      to: tradingDate,
    }))
    .filter((window) => window.from <= window.to);
}

function journalledSources(reads: SqliteSplitReads) {
  return (instrument: string, exchange: EodhdExchange, tradingDate: string): SplitSources => ({
    eodhd: reads.reads('eodhd', eodhdSymbol(instrument, exchange), tradingDate),
    alpaca: exchange === 'US' ? reads.reads('alpaca', instrument, tradingDate) : undefined,
  });
}

export function liveSplitFeed(deps: SplitFeedDeps): SplitFeed {
  const fetchOne = async (fetch: Fetch, tradingDate: string): Promise<void> => {
    const { source, reader, symbol, window } = fetch;
    if (deps.reads.covered(source, symbol, tradingDate, window.from)) return;
    if (reader === undefined) {
      deps.reads.recordFailure(
        tradingDate,
        source,
        { symbol, ...window, reason: NO_ALPACA_KEY },
        deps.clock.now(),
      );
      return;
    }
    try {
      deps.reads.recordRead(
        tradingDate,
        source,
        await reader.splits(symbol, window),
        deps.clock.now(),
      );
    } catch (error) {
      deps.reads.recordFailure(
        tradingDate,
        source,
        { symbol, ...window, reason: reasonOf(error) },
        deps.clock.now(),
      );
    }
  };
  return {
    checks: deps.checks,
    sources: journalledSources(deps.reads),
    async refresh(requests, tradingDate) {
      for (const { instrument, exchange, ...window } of mergedWindows(requests, tradingDate)) {
        const symbol = eodhdSymbol(instrument, exchange);
        await fetchOne({ source: 'eodhd', reader: deps.eodhd, symbol, window }, tradingDate);
        if (exchange !== 'US') continue;
        await fetchOne(
          { source: 'alpaca', reader: deps.alpaca, symbol: instrument, window },
          tradingDate,
        );
      }
    },
  };
}

// Replay answers only from the journal: a day with no split read ran without the feed
export function journalledSplitFeed(
  reads: SqliteSplitReads,
  checks: SplitCheckLedger,
  tradingDate: string,
): SplitFeed | undefined {
  if (!reads.anyOn(tradingDate)) return undefined;
  return {
    checks,
    sources: journalledSources(reads),
    refresh: () => Promise.resolve(),
  };
}
