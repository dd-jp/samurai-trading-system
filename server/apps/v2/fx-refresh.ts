import { type Logger, readSeededFile } from '../../shared/index.js';
import {
  type BarRefresh,
  logRefresh,
  messageOf,
  type TimeLimit,
  UNLIMITED,
  withinTimeLimit,
} from './bar-refresh-core.js';
import { writeAtomically } from './cfd-catalogue-refresh.js';
import { addDays, type BoeFix, type BoeSeries, parseBoeSeriesCsv } from './data/index.js';

export type FxFetch = (
  url: string,
  init: { readonly signal: AbortSignal; readonly headers: Readonly<Record<string, string>> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
}>;

// Re-reading the last two weeks proves the new rows join the file's series: a revised or
// missing overlap row refuses the append instead of splicing two different series
const OVERLAP_DAYS = 14;

const FX_REFRESH_TIME_LIMIT_MS = 30_000;

// The IADB is reported to answer non-browser user agents with an error page (#2000)
const BOE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/129.0.0.0 Safari/537.36';

const BOE_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function boeQueryDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}/${BOE_MONTHS[Number(month) - 1]}/${year}`;
}

export function boeFxUrl(from: string, series: BoeSeries = 'XUDLUSS'): string {
  return (
    'https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp?csv.x=yes' +
    `&Datefrom=${boeQueryDate(from)}&Dateto=now&SeriesCodes=${series}&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`
  );
}

export interface FxAppend {
  readonly text: string;
  readonly added: readonly BoeFix[];
}

function dataLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(1);
}

// Counted from BoE's first row, not the requested start, so it holds whether Datefrom is inclusive
function assertOverlapAgrees(existing: readonly BoeFix[], fetched: readonly BoeFix[]): void {
  const last = existing.at(-1)?.date ?? '';
  const known = new Map(existing.map((row) => [row.date, row.rate]));
  const overlap = fetched.filter((row) => row.date <= last);
  const from = overlap[0]?.date;
  if (from === undefined) {
    throw new Error(`fx refresh: BoE returned no row on or before the file's last fix ${last}`);
  }
  const expected = existing.filter((row) => row.date >= from).length;
  if (overlap.length !== expected) {
    throw new Error(
      `fx refresh: BoE returned ${overlap.length} rows from ${from} to ${last}, the file holds ${expected}`,
    );
  }
  const revised = overlap.find((row) => known.get(row.date) !== row.rate);
  if (revised !== undefined) {
    throw new Error(
      `fx refresh: BoE ${revised.date} is ${revised.rate}, the file holds ${known.get(revised.date)}`,
    );
  }
}

export function overlapStart(existing: readonly BoeFix[]): string {
  const last = existing.at(-1);
  if (last === undefined) throw new Error('fx refresh: the file holds no rows to extend');
  return addDays(last.date, -OVERLAP_DAYS);
}

export function appendBoeRows(
  existingText: string,
  fetchedText: string,
  series: BoeSeries = 'XUDLUSS',
): FxAppend {
  const existing = parseBoeSeriesCsv(existingText, series);
  const fetched = parseBoeSeriesCsv(fetchedText, series);
  if (!fetchedText.endsWith('\n')) {
    throw new Error('fx refresh: the BoE response ends mid-row, so its last fix may be cut short');
  }
  assertOverlapAgrees(existing, fetched);
  const lastDate = existing.at(-1)?.date ?? '';
  const fetchedLines = dataLines(fetchedText);
  const newIndexes = fetched.flatMap((row, index) => (row.date > lastDate ? [index] : []));
  if (newIndexes.length === 0) return { text: existingText, added: [] };
  const appended = newIndexes.map((index) => fetchedLines[index]).join('\n');
  const text = `${existingText.trimEnd()}\n${appended}\n`;
  parseBoeSeriesCsv(text, series);
  return { text, added: newIndexes.flatMap((index) => fetched[index] ?? []) };
}

export interface FxRefreshLeg {
  readonly path: string;
  readonly logger: Logger;
  readonly fetch: FxFetch;
  readonly series?: BoeSeries;
  readonly timeLimitMs?: number;
}

export async function refreshBoeFx(
  leg: FxRefreshLeg,
  limit: TimeLimit = UNLIMITED,
): Promise<FxAppend> {
  const series = leg.series ?? 'XUDLUSS';
  const existingText = readSeededFile(leg.path);
  const from = overlapStart(parseBoeSeriesCsv(existingText, series));
  const response = await leg.fetch(boeFxUrl(from, series), {
    signal: limit.signal,
    headers: { 'User-Agent': BOE_USER_AGENT },
  });
  if (!response.ok) throw new Error(`fx refresh: BoE IADB answered HTTP ${response.status}`);
  const result = appendBoeRows(existingText, await response.text(), series);
  if (result.added.length > 0)
    await limit.atomic(async () => writeAtomically(leg.path, result.text));
  return result;
}

const STALE_FILE_CONSEQUENCE: Readonly<Record<BoeSeries, string>> = {
  XUDLUSS: "the tax log holds out every USD fill after the file's last fix",
  XUDLERS: 'a EUR CFD dividend line leaves its date unmarked once the year-start fix is missing',
};

function summary(series: BoeSeries, added: readonly BoeFix[]): string {
  const last = added.at(-1);
  return last === undefined
    ? `BoE ${series} has no fix after the file`
    : `BoE ${series} appended ${added.length} fixes to ${last.date}`;
}

export function fxRefreshFor(leg: FxRefreshLeg): BarRefresh {
  const series = leg.series ?? 'XUDLUSS';
  return {
    run: async () => {
      try {
        const limitMs = leg.timeLimitMs ?? FX_REFRESH_TIME_LIMIT_MS;
        const { added } = await withinTimeLimit(
          limitMs,
          (limit) => refreshBoeFx(leg, limit),
          () => {
            throw new Error(`fx refresh: BoE IADB gave no answer within ${limitMs / 1000} s`);
          },
        );
        logRefresh(leg.logger, 'info', 'v2_fx_refresh_summary', summary(series, added));
      } catch (error) {
        logRefresh(
          leg.logger,
          'warn',
          'v2_fx_refresh_failed',
          `${messageOf(error)}; ${STALE_FILE_CONSEQUENCE[series]}`,
        );
      }
      return { attempted: 0, updated: [], noNewBars: [], failed: [] };
    },
  };
}
