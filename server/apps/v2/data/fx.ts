const MONTHS: Record<string, string> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};

export interface FxObservation {
  readonly date: string;
  readonly gbpUsd: number;
}

const BOE_DATE = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/;

function parseBoeDate(raw: string): string {
  const [, day, month, year] = BOE_DATE.exec(raw.trim()) ?? [];
  const mm = MONTHS[month ?? ''];
  if (day === undefined || mm === undefined || year === undefined) {
    throw new Error(`fx: unparseable BoE date ${JSON.stringify(raw)}`);
  }
  return `${year}-${mm}-${day.padStart(2, '0')}`;
}

export function parseBoeGbpUsdCsv(text: string): readonly FxObservation[] {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const header = lines.shift();
  if (header?.trim() !== 'DATE,XUDLUSS') throw new Error(`fx: unexpected header ${header}`);
  return assertAscending(
    lines.map((line) => {
      const [date, rate] = line.split(',');
      const gbpUsd = Number(rate);
      if (!(gbpUsd > 0)) throw new Error(`fx: bad row ${line}`);
      return { date: parseBoeDate(date ?? ''), gbpUsd };
    }),
  );
}

function assertAscending(observations: readonly FxObservation[]): readonly FxObservation[] {
  for (const [index, row] of observations.entries()) {
    const previous = observations[index - 1];
    if (previous !== undefined && previous.date >= row.date) {
      throw new Error(`fx: dates not strictly ascending at ${row.date} after ${previous.date}`);
    }
  }
  return observations;
}

export function yearStartFix(observations: readonly FxObservation[], year: number): FxObservation {
  const cutoff = `${year}-01-01`;
  const onOrBefore = observations.filter((row) => row.date <= cutoff);
  const last = onOrBefore.at(-1);
  if (last === undefined) throw new Error(`fx: no GBPUSD observation on or before ${cutoff}`);
  return last;
}

export function yearStartGbpUsd(observations: readonly FxObservation[], year: number): number {
  return yearStartFix(observations, year).gbpUsd;
}

export const FX_PATH = 'data/bars/fx/gbpusd-boe-xudluss.csv';

export const FX_SNAPSHOT_PATH = 'data/bars/fx/gbpusd-boe-xudluss.snapshot.csv';

export const FX_SOURCE_GBP = 'gbp';

// BoE publishes no fix on UK bank holidays; Easter and Christmas leave at most four days between
// fixes, so a longer gap is a hole in the series, not a holiday
export const DAY_FIX_MAX_GAP_DAYS = 7;

export type DayFix =
  | { readonly ok: true; readonly gbpUsd: number; readonly fixDate: string }
  | { readonly ok: false; readonly reason: string };

// The fix is named because the series can end before 1 January: a stale fix must read as one
export function yearStartFxSource(year: number, fixDate: string | undefined): string {
  return `boe-xudluss:year-start:${year}@${fixDate ?? 'unknown'}`;
}

export function dayFxSource(fixDate: string): string {
  return `boe-xudluss:${fixDate}`;
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

// Exits, fills and marks keep pricing at a stale year-start fix, named in fx_source (#1947);
// only entries refuse it (#2009)
export function staleYearStartReason(year: number, fixDate: string): string | undefined {
  const cutoff = `${year}-01-01`;
  if (daysBetween(fixDate, cutoff) <= DAY_FIX_MAX_GAP_DAYS) return undefined;
  return `last BoE XUDLUSS fix on or before ${cutoff} is ${fixDate}, more than ${DAY_FIX_MAX_GAP_DAYS} days before it`;
}

export function dayGbpUsd(observations: readonly FxObservation[], date: string): DayFix {
  const last = observations.at(-1);
  if (last === undefined || last.date < date) {
    return {
      ok: false,
      reason: `BoE XUDLUSS series ends ${last?.date ?? 'empty'}, before ${date}`,
    };
  }
  const fix = observations.findLast((row) => row.date <= date);
  if (fix === undefined || daysBetween(fix.date, date) > DAY_FIX_MAX_GAP_DAYS) {
    return {
      ok: false,
      reason: `no BoE XUDLUSS fix in the ${DAY_FIX_MAX_GAP_DAYS} days to ${date}`,
    };
  }
  return { ok: true, gbpUsd: fix.gbpUsd, fixDate: fix.date };
}
