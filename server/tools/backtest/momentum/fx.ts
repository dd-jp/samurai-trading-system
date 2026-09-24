const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface FxRate {
  readonly date: string;
  readonly usdPerGbp: number;
}

export function parseBoeXudlussCsv(text: string): FxRate[] {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines[0]?.trim() !== 'DATE,XUDLUSS') {
    throw new Error(`BoE XUDLUSS: unexpected header '${lines[0]}'`);
  }
  const rates = lines.slice(1).map(parseBoeLine);
  for (let index = 1; index < rates.length; index++) {
    if ((rates[index] as FxRate).date <= (rates[index - 1] as FxRate).date) {
      throw new Error(`BoE XUDLUSS: dates not ascending at ${(rates[index] as FxRate).date}`);
    }
  }
  return rates;
}

function parseBoeLine(line: string): FxRate {
  const match = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4}),([0-9.]+)\s*$/.exec(line);
  if (match === null) throw new Error(`BoE XUDLUSS: malformed row '${line}'`);
  const month = MONTHS.indexOf(match[2] as string);
  if (month === -1) throw new Error(`BoE XUDLUSS: unknown month in '${line}'`);
  const rate = Number(match[4]);
  if (!(rate > 0)) throw new Error(`BoE XUDLUSS: non-positive rate in '${line}'`);
  return {
    date: `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1]}`,
    usdPerGbp: rate,
  };
}

export class YearFixedFx {
  private readonly byYear = new Map<number, number>();

  constructor(private readonly rates: readonly FxRate[]) {}

  usdPerGbpFor(year: number): number {
    const cached = this.byYear.get(year);
    if (cached !== undefined) return cached;
    const asAt = `${year}-01-01`;
    let found: FxRate | undefined;
    for (const rate of this.rates) {
      if (rate.date > asAt) break;
      found = rate;
    }
    if (found === undefined) throw new Error(`YearFixedFx: no rate on or before ${asAt}`);
    this.byYear.set(year, found.usdPerGbp);
    return found.usdPerGbp;
  }
}

export const GBP_IDENTITY_FX = { usdPerGbpFor: (): number => 1 } satisfies Pick<
  YearFixedFx,
  'usdPerGbpFor'
>;

export type BookFx = Pick<YearFixedFx, 'usdPerGbpFor'>;
