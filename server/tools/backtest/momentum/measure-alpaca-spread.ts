import { readFileSync, writeFileSync } from 'node:fs';
import { isMainModule } from '../../cli-entrypoint.js';
import { ALPACA_DATA_BASE_URL, AlpacaBarsApi, credentialsFromEnv } from './alpaca-bars-api.js';
import { parseBarCsv } from './bar-csv.js';
import { PointInTimeMembership, parseConstituentsCsv } from './constituents.js';
import { alpacaSymbolCandidates, DEFAULT_CONSTITUENTS_PATH } from './pull-alpaca-bars.js';

export const DEFAULT_SPREAD_PATH = 'data/bars/alpaca-spreads.csv';
export const SPREAD_CSV_HEADER = 'symbol,sessions,median_half_spread_bps';
export const SAMPLE_TIME_UTC = '19:59:00Z';
export const SAMPLE_WINDOW_SECONDS = 30;
export const DEFAULT_SESSIONS = 10;

export interface QuoteSample {
  readonly bid: number;
  readonly ask: number;
}

export function quotesUrl(symbol: string, date: string): string {
  const start = `${date}T${SAMPLE_TIME_UTC}`;
  const endSeconds = String(SAMPLE_WINDOW_SECONDS).padStart(2, '0');
  const end = `${date}T${SAMPLE_TIME_UTC.slice(0, 6)}${endSeconds}Z`;
  const params = new URLSearchParams({ start, end, limit: '1', feed: 'sip', sort: 'asc' });
  return `${ALPACA_DATA_BASE_URL}/v2/stocks/${encodeURIComponent(symbol)}/quotes?${params.toString()}`;
}

export function parseQuotePage(body: unknown): QuoteSample | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const quotes = (body as { quotes?: unknown }).quotes;
  if (!Array.isArray(quotes) || quotes.length === 0) return undefined;
  const first = quotes[0] as Record<string, unknown>;
  const bid = first.bp;
  const ask = first.ap;
  if (typeof bid !== 'number' || typeof ask !== 'number' || !(bid > 0) || !(ask >= bid))
    return undefined;
  return { bid, ask };
}

export function halfSpreadBps(sample: QuoteSample): number {
  const mid = (sample.bid + sample.ask) / 2;
  return ((sample.ask - sample.bid) / 2 / mid) * 10_000;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median: empty');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export interface SpreadRow {
  readonly symbol: string;
  readonly sessions: number;
  readonly medianHalfSpreadBps: number;
}

export function spreadRowsToCsv(rows: readonly SpreadRow[]): string {
  const lines = [SPREAD_CSV_HEADER];
  for (const row of rows) {
    lines.push(`${row.symbol},${row.sessions},${row.medianHalfSpreadBps.toFixed(3)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseSpreadCsv(text: string): Map<string, SpreadRow> {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines[0]?.trim() !== SPREAD_CSV_HEADER) {
    throw new Error(`spread csv: unexpected header '${lines[0]}'`);
  }
  const rows = new Map<string, SpreadRow>();
  for (const line of lines.slice(1)) {
    const [symbol, sessions, bps] = line.split(',');
    const medianHalfSpreadBps = Number(bps);
    if (symbol === undefined || symbol.length === 0 || !(medianHalfSpreadBps >= 0)) {
      throw new Error(`spread csv: malformed row '${line}'`);
    }
    rows.set(symbol, { symbol, sessions: Number(sessions), medianHalfSpreadBps });
  }
  return rows;
}

export interface HalfSpreadLookup {
  readonly halfSpreadBps: (symbol: string) => number;
  readonly fallbackBps: number;
  readonly measured: number;
}

export function halfSpreadLookup(rows: ReadonlyMap<string, SpreadRow>): HalfSpreadLookup {
  if (rows.size === 0) throw new Error('halfSpreadLookup: no measured spreads');
  const fallbackBps = median([...rows.values()].map((row) => row.medianHalfSpreadBps));
  return {
    halfSpreadBps: (symbol) => rows.get(symbol)?.medianHalfSpreadBps ?? fallbackBps,
    fallbackBps,
    measured: rows.size,
  };
}

export async function measureSymbol(
  api: AlpacaBarsApi,
  ticker: string,
  sessions: readonly string[],
): Promise<SpreadRow | undefined> {
  for (const symbol of alpacaSymbolCandidates(ticker)) {
    const samples: number[] = [];
    for (const date of sessions) {
      const sample = parseQuotePage(await api.getWithRetry(quotesUrl(symbol, date)));
      if (sample !== undefined) samples.push(halfSpreadBps(sample));
    }
    if (samples.length > 0) {
      return { symbol: ticker, sessions: samples.length, medianHalfSpreadBps: median(samples) };
    }
  }
  return undefined;
}

export function lastSessions(calendar: readonly string[], count: number): string[] {
  return calendar.slice(-count);
}

async function main(): Promise<void> {
  const membership = new PointInTimeMembership(
    parseConstituentsCsv(readFileSync(DEFAULT_CONSTITUENTS_PATH, 'utf8')),
  );
  const spy = parseBarCsv('SPY', readFileSync('data/bars/alpaca/SPY.csv', 'utf8'));
  const sessions = lastSessions(
    spy.bars.map((bar) => bar.date),
    DEFAULT_SESSIONS,
  );
  const api = new AlpacaBarsApi(credentialsFromEnv(process.env));
  const current = membership.membersOn(membership.lastDate());
  const rows: SpreadRow[] = [];
  let done = 0;
  for (const ticker of current) {
    const row = await measureSymbol(api, ticker, sessions);
    done++;
    if (row !== undefined) rows.push(row);
    if (done % 25 === 0)
      console.log(`${done}/${current.length} measured, ${rows.length} with quotes`);
  }
  rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  writeFileSync(DEFAULT_SPREAD_PATH, spreadRowsToCsv(rows));
  console.log(
    `wrote ${rows.length} rows to ${DEFAULT_SPREAD_PATH} over sessions ${sessions[0]}..${sessions[sessions.length - 1]}`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
