import { ISO_DATE } from '../../../pipeline/momentum/index.js';

export interface MembershipRow {
  readonly date: string;
  readonly tickers: readonly string[];
}

export function parseConstituentsCsv(text: string): MembershipRow[] {
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines[0] !== 'date,tickers') {
    throw new Error(`constituents: unexpected header '${lines[0]}'`);
  }
  const rows = lines.slice(1).map(parseRow);
  for (let index = 1; index < rows.length; index++) {
    if ((rows[index] as MembershipRow).date <= (rows[index - 1] as MembershipRow).date) {
      throw new Error(`constituents: rows not ascending at ${(rows[index] as MembershipRow).date}`);
    }
  }
  return rows;
}

function parseRow(line: string): MembershipRow {
  const match = /^(\d{4}-\d{2}-\d{2}),"?([^"]*)"?$/.exec(line);
  if (match === null || !ISO_DATE.test(match[1] as string)) {
    throw new Error(`constituents: malformed row '${line.slice(0, 40)}'`);
  }
  const tickers = (match[2] as string)
    .split(',')
    .map((ticker) => ticker.trim())
    .filter((ticker) => ticker.length > 0);
  return { date: match[1] as string, tickers: [...new Set(tickers)].sort() };
}

export class PointInTimeMembership {
  constructor(private readonly rows: readonly MembershipRow[]) {
    if (rows.length === 0) throw new Error('constituents: no membership rows');
  }

  membersOn(date: string): readonly string[] {
    const row = this.rowInForce(date);
    if (row === undefined) {
      throw new Error(
        `constituents: no membership row on or before ${date} (first row ${this.rows[0]?.date})`,
      );
    }
    return row.tickers;
  }

  allTickers(): readonly string[] {
    const set = new Set<string>();
    for (const row of this.rows) for (const ticker of row.tickers) set.add(ticker);
    return [...set].sort();
  }

  firstDate(): string {
    return (this.rows[0] as MembershipRow).date;
  }

  lastDate(): string {
    return (this.rows[this.rows.length - 1] as MembershipRow).date;
  }

  private rowInForce(date: string): MembershipRow | undefined {
    let found: MembershipRow | undefined;
    for (const row of this.rows) {
      if (row.date > date) break;
      found = row;
    }
    return found;
  }
}
