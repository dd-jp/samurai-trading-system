import { constants, copyFileSync, readFileSync } from 'node:fs';
import type { Logger } from '../../shared/index.js';
import {
  type BarRefresh,
  logRefresh,
  messageOf,
  type TimeLimit,
  UNLIMITED,
  withinTimeLimit,
} from './bar-refresh-core.js';
import { writeAtomically } from './cfd-catalogue-refresh.js';
import {
  addDays,
  FX_PATH,
  FX_SNAPSHOT_PATH,
  type FxObservation,
  parseBoeGbpUsdCsv,
} from './data/index.js';

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

export function boeXudlussUrl(from: string): string {
  return (
    'https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp?csv.x=yes' +
    `&Datefrom=${boeQueryDate(from)}&Dateto=now&SeriesCodes=XUDLUSS&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`
  );
}

export interface FxAppend {
  readonly text: string;
  readonly added: readonly FxObservation[];
}

function dataLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(1);
}

// Counted from BoE's first row, not the requested start, so it holds whether Datefrom is inclusive
function assertOverlapAgrees(
  existing: readonly FxObservation[],
  fetched: readonly FxObservation[],
): void {
  const last = existing.at(-1)?.date ?? '';
  const known = new Map(existing.map((row) => [row.date, row.gbpUsd]));
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
  const revised = overlap.find((row) => known.get(row.date) !== row.gbpUsd);
  if (revised !== undefined) {
    throw new Error(
      `fx refresh: BoE ${revised.date} is ${revised.gbpUsd}, the file holds ${known.get(revised.date)}`,
    );
  }
}

export function overlapStart(existing: readonly FxObservation[]): string {
  const last = existing.at(-1);
  if (last === undefined) throw new Error('fx refresh: the file holds no rows to extend');
  return addDays(last.date, -OVERLAP_DAYS);
}

export function appendBoeRows(existingText: string, fetchedText: string): FxAppend {
  const existing = parseBoeGbpUsdCsv(existingText);
  const fetched = parseBoeGbpUsdCsv(fetchedText);
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
  parseBoeGbpUsdCsv(text);
  return { text, added: newIndexes.flatMap((index) => fetched[index] ?? []) };
}

export interface FxRefreshLeg {
  readonly path: string;
  readonly logger: Logger;
  readonly fetch: FxFetch;
  readonly timeLimitMs?: number;
}

export async function refreshBoeFx(
  leg: FxRefreshLeg,
  limit: TimeLimit = UNLIMITED,
): Promise<FxAppend> {
  const existingText = readFileSync(leg.path, 'utf8');
  const from = overlapStart(parseBoeGbpUsdCsv(existingText));
  const response = await leg.fetch(boeXudlussUrl(from), {
    signal: limit.signal,
    headers: { 'User-Agent': BOE_USER_AGENT },
  });
  if (!response.ok) throw new Error(`fx refresh: BoE IADB answered HTTP ${response.status}`);
  const result = appendBoeRows(existingText, await response.text());
  if (result.added.length > 0)
    await limit.atomic(async () => writeAtomically(leg.path, result.text));
  return result;
}

export function seedFxFile(path: string = FX_PATH, snapshot: string = FX_SNAPSHOT_PATH): boolean {
  try {
    copyFileSync(snapshot, path, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Without a snapshot the root's own read of the live file names what is missing
    if (code === 'EEXIST' || code === 'ENOENT') return false;
    throw error;
  }
}

function summary(added: readonly FxObservation[]): string {
  const last = added.at(-1);
  return last === undefined
    ? 'BoE XUDLUSS has no fix after the file'
    : `BoE XUDLUSS appended ${added.length} fixes to ${last.date}`;
}

export function fxRefreshFor(leg: FxRefreshLeg): BarRefresh {
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
        logRefresh(leg.logger, 'info', 'v2_fx_refresh_summary', summary(added));
      } catch (error) {
        logRefresh(
          leg.logger,
          'warn',
          'v2_fx_refresh_failed',
          `${messageOf(error)}; the tax log holds out every USD fill after the file's last fix`,
        );
      }
      return { attempted: 0, updated: [], noNewBars: [], failed: [] };
    },
  };
}
