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
  return lines.map((line) => {
    const [date, rate] = line.split(',');
    const gbpUsd = Number(rate);
    if (!(gbpUsd > 0)) throw new Error(`fx: bad row ${line}`);
    return { date: parseBoeDate(date ?? ''), gbpUsd };
  });
}

export function yearStartGbpUsd(observations: readonly FxObservation[], year: number): number {
  const cutoff = `${year}-01-01`;
  const onOrBefore = observations.filter((row) => row.date <= cutoff);
  const last = onOrBefore.at(-1);
  if (last === undefined) throw new Error(`fx: no GBPUSD observation on or before ${cutoff}`);
  return last.gbpUsd;
}
