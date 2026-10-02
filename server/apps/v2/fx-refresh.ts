import { readFileSync } from 'node:fs';
import type { Logger } from '../../shared/index.js';
import { type BarRefresh, logRefresh, messageOf } from './bar-refresh-core.js';
import { writeAtomically } from './cfd-catalogue-refresh.js';
import { addDays, type FxObservation, parseBoeGbpUsdCsv } from './data/index.js';

export type FxFetch = (url: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
}>;

// Re-reading the last two weeks proves the new rows join the file's series: a revised or
// missing overlap row refuses the append instead of splicing two different series
const OVERLAP_DAYS = 14;

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

function assertOverlapAgrees(
  existing: readonly FxObservation[],
  fetched: readonly FxObservation[],
  from: string,
): void {
  const last = existing.at(-1)?.date ?? '';
  const known = new Map(existing.map((row) => [row.date, row.gbpUsd]));
  const overlap = fetched.filter((row) => row.date <= last);
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

export function appendBoeRows(existingText: string, fetchedText: string, from: string): FxAppend {
  const existing = parseBoeGbpUsdCsv(existingText);
  const fetched = parseBoeGbpUsdCsv(fetchedText);
  assertOverlapAgrees(existing, fetched, from);
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
}

export async function refreshBoeFx(leg: FxRefreshLeg): Promise<FxAppend> {
  const existingText = readFileSync(leg.path, 'utf8');
  const from = overlapStart(parseBoeGbpUsdCsv(existingText));
  const response = await leg.fetch(boeXudlussUrl(from));
  if (!response.ok) throw new Error(`fx refresh: BoE IADB answered HTTP ${response.status}`);
  const result = appendBoeRows(existingText, await response.text(), from);
  if (result.added.length > 0) writeAtomically(leg.path, result.text);
  return result;
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
        const { added } = await refreshBoeFx(leg);
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
