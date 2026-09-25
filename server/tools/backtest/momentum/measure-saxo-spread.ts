import { writeFileSync } from 'node:fs';
import { resolveSaxoOAuthConfig } from '../../../pipeline/execution/adapters/saxo-oauth.js';
import { isMainModule } from '../../cli-entrypoint.js';
import { LSE_MOMENTUM_LINES } from './lse-lines.js';
import { halfSpreadBps, median } from './measure-alpaca-spread.js';
import type { InfoPriceQuote } from './saxo-api.js';
import { liveTokenSource, SaxoReadOnlyApi } from './saxo-api.js';

export const DEFAULT_SAXO_SPREAD_PATH = 'data/bars/saxo-spreads.csv';
export const SAXO_SPREAD_CSV_HEADER =
  'symbol,uic,samples,p25_half_spread_bps,median_half_spread_bps,measured_at';
export const BURST_READS = 5;
export const BURST_SPACING_MS = 2_000;

export interface SaxoSpreadRow {
  readonly symbol: string;
  readonly uic: number;
  readonly samples: number;
  readonly p25HalfSpreadBps: number;
  readonly medianHalfSpreadBps: number;
  readonly measuredAt: string;
}

export function nearestRankPercentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error('nearestRankPercentile: empty');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] as number;
}

export function burstRows(
  bursts: readonly (readonly InfoPriceQuote[])[],
  measuredAt: string,
): SaxoSpreadRow[] {
  const byUic = new Map<number, number[]>();
  for (const burst of bursts) {
    for (const quote of burst) {
      const list = byUic.get(quote.uic) ?? [];
      list.push(halfSpreadBps(quote));
      byUic.set(quote.uic, list);
    }
  }
  const rows: SaxoSpreadRow[] = [];
  for (const line of LSE_MOMENTUM_LINES) {
    const samples = byUic.get(line.uic);
    if (samples === undefined || samples.length === 0) continue;
    rows.push({
      symbol: line.tidm,
      uic: line.uic,
      samples: samples.length,
      p25HalfSpreadBps: nearestRankPercentile(samples, 0.25),
      medianHalfSpreadBps: median(samples),
      measuredAt,
    });
  }
  return rows;
}

export function saxoSpreadRowsToCsv(rows: readonly SaxoSpreadRow[]): string {
  const lines = [SAXO_SPREAD_CSV_HEADER];
  for (const row of rows) {
    lines.push(
      `${row.symbol},${row.uic},${row.samples},${row.p25HalfSpreadBps.toFixed(3)},${row.medianHalfSpreadBps.toFixed(3)},${row.measuredAt}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function parseSaxoSpreadCsv(text: string): Map<string, SaxoSpreadRow> {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines[0]?.trim() !== SAXO_SPREAD_CSV_HEADER) {
    throw new Error(`saxo spread csv: unexpected header '${lines[0]}'`);
  }
  const rows = new Map<string, SaxoSpreadRow>();
  for (const line of lines.slice(1)) {
    const [symbol, uic, samples, p25, med, measuredAt] = line.split(',');
    const p25HalfSpreadBps = Number(p25);
    const medianHalfSpreadBps = Number(med);
    if (
      symbol === undefined ||
      symbol.length === 0 ||
      !(p25HalfSpreadBps >= 0) ||
      !(medianHalfSpreadBps >= 0) ||
      measuredAt === undefined
    ) {
      throw new Error(`saxo spread csv: malformed row '${line}'`);
    }
    rows.set(symbol, {
      symbol,
      uic: Number(uic),
      samples: Number(samples),
      p25HalfSpreadBps,
      medianHalfSpreadBps,
      measuredAt,
    });
  }
  return rows;
}

export type SaxoQuoteApi = Pick<SaxoReadOnlyApi, 'infoPrices'>;

export async function readQuoteBursts(
  api: SaxoQuoteApi,
  uics: readonly number[],
  sleep: (ms: number) => Promise<void>,
): Promise<InfoPriceQuote[][]> {
  const bursts: InfoPriceQuote[][] = [];
  for (let read = 0; read < BURST_READS; read++) {
    if (read > 0) await sleep(BURST_SPACING_MS);
    const quotes = await api.infoPrices(uics);
    bursts.push(quotes);
    console.log(
      `read ${read + 1}/${BURST_READS}: ${quotes.length} quotes, delayed ${quotes[0]?.delayedByMinutes ?? '?'} min, state ${quotes[0]?.marketState ?? '?'}`,
    );
  }
  return bursts;
}

export function spreadSummary(rows: readonly SaxoSpreadRow[], path: string): string {
  const missing = LSE_MOMENTUM_LINES.filter((line) => !rows.some((row) => row.uic === line.uic));
  return (
    `wrote ${rows.length} rows to ${path}; p25 across lines median ${median(rows.map((row) => row.p25HalfSpreadBps)).toFixed(2)} bps` +
    (missing.length > 0 ? `; no quote for ${missing.map((line) => line.tidm).join(', ')}` : '')
  );
}

async function main(argv: readonly string[]): Promise<void> {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const rawPath = value('--raw');
  const tokens = liveTokenSource(process.env, value('--token-file'));
  const api = new SaxoReadOnlyApi(
    tokens,
    resolveSaxoOAuthConfig('live', process.env).gatewayBaseUrl,
  );
  const uics = LSE_MOMENTUM_LINES.map((line) => line.uic);
  const measuredAt = new Date().toISOString();
  const bursts = await readQuoteBursts(
    api,
    uics,
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ).finally(() => tokens.stop());
  const rows = burstRows(bursts, measuredAt);
  writeFileSync(DEFAULT_SAXO_SPREAD_PATH, saxoSpreadRowsToCsv(rows));
  if (rawPath !== undefined)
    writeFileSync(rawPath, `${JSON.stringify({ measuredAt, bursts }, null, 1)}\n`);
  console.log(spreadSummary(rows, DEFAULT_SAXO_SPREAD_PATH));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
