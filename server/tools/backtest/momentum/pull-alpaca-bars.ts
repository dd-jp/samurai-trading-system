import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DailyBar } from '../../../pipeline/momentum/index.js';
import { isMainModule } from '../../cli-entrypoint.js';
import { AlpacaBarsApi, credentialsFromEnv, type RawDailyBar } from './alpaca-bars-api.js';
import { barsToCsv } from './bar-csv.js';
import { PointInTimeMembership, parseConstituentsCsv } from './constituents.js';

const US_BARS_START = '2016-01-04';
const US_CALENDAR_REFERENCE = 'SPY';
export const DEFAULT_CONSTITUENTS_PATH = 'data/bars/sp500-constituents.csv';
export const DEFAULT_ALPACA_BARS_DIR = 'data/bars/alpaca';

interface SymbolManifestEntry {
  readonly alpaca_symbol: string;
  readonly first: string;
  readonly last: string;
  readonly bars: number;
}

interface AlpacaBarsManifest {
  readonly source: string;
  readonly feed: 'sip';
  readonly adjustment: 'all (OHLCV) + raw (raw_close)';
  readonly start: string;
  readonly end: string;
  readonly fetched_at: string;
  readonly calendar_reference: string;
  readonly symbols: Record<string, SymbolManifestEntry>;
  readonly missing: string[];
}

export function barDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

export function joinAdjustedAndRaw(
  symbol: string,
  adjusted: readonly RawDailyBar[],
  raw: readonly RawDailyBar[],
): DailyBar[] {
  const rawClose = new Map(raw.map((bar) => [barDate(bar.t), bar.c]));
  return adjusted.map((bar) => {
    const date = barDate(bar.t);
    const close = rawClose.get(date);
    if (close === undefined) {
      throw new Error(`${symbol}: adjusted bar ${date} has no raw counterpart`);
    }
    return {
      date,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
      rawClose: close,
    };
  });
}

export function alpacaSymbolCandidates(ticker: string): readonly string[] {
  return ticker.includes('.') ? [ticker, ticker.replace('.', '')] : [ticker];
}

export async function pullSymbol(
  api: AlpacaBarsApi,
  ticker: string,
  start: string,
  end: string,
): Promise<{ alpacaSymbol: string; bars: DailyBar[] } | undefined> {
  for (const alpacaSymbol of alpacaSymbolCandidates(ticker)) {
    const adjusted = await api.dailyBars({ symbol: alpacaSymbol, start, end, adjustment: 'all' });
    if (adjusted.length === 0) continue;
    const raw = await api.dailyBars({ symbol: alpacaSymbol, start, end, adjustment: 'raw' });
    return { alpacaSymbol, bars: joinAdjustedAndRaw(ticker, adjusted, raw) };
  }
  return undefined;
}

export function parsePullArgs(argv: readonly string[]): {
  end: string;
  constituents: string;
  outDir: string;
} {
  const value = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index === -1 ? fallback : (argv[index + 1] ?? fallback);
  };
  return {
    end: value('--end', new Date().toISOString().slice(0, 10)),
    constituents: value('--constituents', DEFAULT_CONSTITUENTS_PATH),
    outDir: value('--out', DEFAULT_ALPACA_BARS_DIR),
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parsePullArgs(argv);
  const membership = new PointInTimeMembership(
    parseConstituentsCsv(readFileSync(args.constituents, 'utf8')),
  );
  const tickers = [US_CALENDAR_REFERENCE, ...membership.allTickers()];
  const api = new AlpacaBarsApi(credentialsFromEnv(process.env));
  mkdirSync(args.outDir, { recursive: true });

  const symbols: Record<string, SymbolManifestEntry> = {};
  const missing: string[] = [];
  let done = 0;
  for (const ticker of tickers) {
    const pulled = await pullSymbol(api, ticker, US_BARS_START, args.end);
    done++;
    if (pulled === undefined) {
      missing.push(ticker);
      console.log(`${done}/${tickers.length} ${ticker}: no SIP bars`);
      continue;
    }
    writeFileSync(join(args.outDir, `${ticker}.csv`), barsToCsv(pulled.bars));
    const first = pulled.bars[0]?.date ?? '';
    const last = pulled.bars[pulled.bars.length - 1]?.date ?? '';
    symbols[ticker] = { alpaca_symbol: pulled.alpacaSymbol, first, last, bars: pulled.bars.length };
    if (done % 25 === 0)
      console.log(`${done}/${tickers.length} ${ticker}: ${pulled.bars.length} bars`);
  }

  const manifest: AlpacaBarsManifest = {
    source: 'Alpaca GET /v2/stocks/bars, timeframe=1Day, feed=sip',
    feed: 'sip',
    adjustment: 'all (OHLCV) + raw (raw_close)',
    start: US_BARS_START,
    end: args.end,
    fetched_at: new Date().toISOString(),
    calendar_reference: US_CALENDAR_REFERENCE,
    symbols,
    missing,
  };
  writeFileSync(join(args.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`pulled ${Object.keys(symbols).length} symbols, ${missing.length} missing`);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
