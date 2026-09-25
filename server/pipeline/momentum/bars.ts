export interface DailyBar {
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly rawClose: number;
}

export interface BarSeries {
  readonly symbol: string;
  readonly bars: readonly DailyBar[];
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertSortedUniqueDates(series: BarSeries): void {
  let previous = '';
  for (const bar of series.bars) {
    if (!ISO_DATE.test(bar.date)) {
      throw new Error(`${series.symbol}: bar date '${bar.date}' is not YYYY-MM-DD`);
    }
    if (bar.date <= previous) {
      throw new Error(`${series.symbol}: bars not strictly ascending at ${bar.date}`);
    }
    previous = bar.date;
  }
}

export interface WindowCoverage {
  readonly required: number;
  readonly present: number;
  readonly ratio: number;
  readonly endsOnDecisionDay: boolean;
}

export const MIN_WINDOW_COVERAGE = 0.95;

export function windowCoverage(
  calendar: readonly string[],
  barDates: ReadonlySet<string>,
  decisionIndex: number,
  lookbackDays: number,
): WindowCoverage {
  if (decisionIndex < 0 || decisionIndex >= calendar.length) {
    throw new Error(`windowCoverage: decisionIndex ${decisionIndex} outside calendar`);
  }
  if (lookbackDays < 1) {
    throw new Error(`windowCoverage: lookbackDays must be >= 1 (got ${lookbackDays})`);
  }
  const startIndex = decisionIndex - lookbackDays;
  if (startIndex < 0) {
    return { required: lookbackDays + 1, present: 0, ratio: 0, endsOnDecisionDay: false };
  }
  let present = 0;
  for (let index = startIndex; index <= decisionIndex; index++) {
    if (barDates.has(calendar[index] as string)) present++;
  }
  const required = lookbackDays + 1;
  return {
    required,
    present,
    ratio: present / required,
    endsOnDecisionDay: barDates.has(calendar[decisionIndex] as string),
  };
}

export function coverageSatisfied(
  coverage: WindowCoverage,
  minRatio = MIN_WINDOW_COVERAGE,
): boolean {
  return coverage.endsOnDecisionDay && coverage.ratio >= minRatio;
}
