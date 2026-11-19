import type {
  BookCorrelationWire,
  BookExposureWire,
  BookSpec,
  CrossSleeveExposureWire,
  ExposureHoldingWire,
  PanelWire,
  SymbolOverlapWire,
} from '../../../contracts/index.js';
import type { Clock } from '../../shared/index.js';
import { type StoreHandle, toStoredTimestamp } from '../../shared/store/index.js';
import type { CrossSleeveWarnLevels } from './signal/index.js';

export interface EquityRow {
  readonly book_id: string;
  readonly trading_date: string;
  readonly equity_gbp: number;
}

export interface ExposureInput {
  readonly tradingDate: string;
  readonly books: readonly BookSpec[];
  readonly holdings: readonly ExposureHoldingWire[];
  readonly equity: readonly EquityRow[];
  readonly levels: CrossSleeveWarnLevels;
}

function bookExposure(book: BookSpec, holdings: readonly ExposureHoldingWire[]): BookExposureWire {
  let long = 0;
  let short = 0;
  for (const { book_id, signed_gbp } of holdings) {
    if (book_id !== book.id) continue;
    if (signed_gbp > 0) long += signed_gbp;
    else short -= signed_gbp;
  }
  return {
    book_id: book.id,
    sleeve_id: book.sleeve,
    variant: book.variant,
    long_gbp: long,
    short_gbp: short,
    gross_gbp: long + short,
    net_gbp: long - short,
  };
}

function overlaps(holdings: readonly ExposureHoldingWire[]): SymbolOverlapWire[] {
  const byInstrument = new Map<string, ExposureHoldingWire[]>();
  for (const holding of holdings) {
    if (holding.signed_gbp === 0) continue;
    byInstrument.set(holding.instrument, [
      ...(byInstrument.get(holding.instrument) ?? []),
      holding,
    ]);
  }
  const found: SymbolOverlapWire[] = [];
  for (const [instrument, holders] of [...byInstrument].sort(([a], [b]) => a.localeCompare(b))) {
    const sleeves = [...new Set(holders.map((holder) => holder.sleeve_id))].sort();
    if (sleeves.length < 2) continue;
    const opposed =
      holders.some((holder) => holder.signed_gbp > 0) &&
      holders.some((holder) => holder.signed_gbp < 0);
    found.push({ instrument, sleeves, opposed, holders });
  }
  return found;
}

function returnsOn(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): [number[], number[]] {
  const dates = [...a.keys()].filter((date) => b.has(date)).sort();
  const left: number[] = [];
  const right: number[] = [];
  let before: readonly [number, number] | undefined;
  for (const date of dates) {
    const after = [a.get(date) as number, b.get(date) as number] as const;
    if (before !== undefined && before[0] > 0 && before[1] > 0) {
      left.push(after[0] / before[0] - 1);
      right.push(after[1] / before[1] - 1);
    }
    before = after;
  }
  return [left, right];
}

export function pearson(left: readonly number[], right: readonly number[]): number | null {
  const n = left.length;
  const meanLeft = left.reduce((sum, value) => sum + value, 0) / n;
  const meanRight = right.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;
  for (let index = 0; index < n; index += 1) {
    const dl = (left[index] as number) - meanLeft;
    const dr = (right[index] as number) - meanRight;
    covariance += dl * dr;
    varianceLeft += dl * dl;
    varianceRight += dr * dr;
  }
  if (varianceLeft === 0 || varianceRight === 0) return null;
  return covariance / Math.sqrt(varianceLeft * varianceRight);
}

function correlation(
  a: BookSpec,
  b: BookSpec,
  series: ReadonlyMap<string, ReadonlyMap<string, number>>,
  levels: CrossSleeveWarnLevels,
): BookCorrelationWire {
  const empty = new Map<string, number>();
  const [left, right] = returnsOn(series.get(a.id) ?? empty, series.get(b.id) ?? empty);
  const window = [left.slice(-levels.windowReturns), right.slice(-levels.windowReturns)] as const;
  const observations = window[0].length;
  const base = { book_a: a.id, book_b: b.id, cross_sleeve: a.sleeve !== b.sleeve, observations };
  if (observations < levels.minObservations) {
    return { ...base, correlation: null, gap: 'warm_up' };
  }
  const value = pearson(...window);
  return value === null
    ? { ...base, correlation: null, gap: 'zero_variance' }
    : { ...base, correlation: value, gap: null };
}

function seriesByBook(rows: readonly EquityRow[], through: string) {
  const series = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (row.trading_date > through) continue;
    const book = series.get(row.book_id) ?? new Map<string, number>();
    book.set(row.trading_date, row.equity_gbp);
    series.set(row.book_id, book);
  }
  return series;
}

function warnings(
  found: readonly SymbolOverlapWire[],
  pairs: readonly BookCorrelationWire[],
  primaries: ReadonlySet<string>,
  levels: CrossSleeveWarnLevels,
): string[] {
  const correlated = pairs.filter(
    (pair) =>
      pair.cross_sleeve &&
      primaries.has(pair.book_a) &&
      primaries.has(pair.book_b) &&
      pair.correlation !== null &&
      Math.abs(pair.correlation) >= levels.correlation,
  );
  const overlapping = found.length >= levels.overlapInstruments ? found : [];
  return [
    ...overlapping.map((overlap) => `overlap:${overlap.instrument}`),
    ...correlated.map((pair) => `correlation:${pair.book_a}|${pair.book_b}`),
  ];
}

export function crossSleeveExposure(input: ExposureInput): CrossSleeveExposureWire {
  const { levels } = input;
  const books = [...input.books].sort((a, b) => a.id.localeCompare(b.id));
  const series = seriesByBook(input.equity, input.tradingDate);
  const pairs = books.flatMap((a, index) =>
    books.slice(index + 1).map((b) => correlation(a, b, series, levels)),
  );
  // Only a primary book carries its sleeve's capital; shadows and arm 2 are counterfactual paper, so
  // their pairs are reported but never overlap or warn
  const primaries = new Set(books.filter((book) => book.variant === 'primary').map(({ id }) => id));
  const found = overlaps(input.holdings.filter((holding) => primaries.has(holding.book_id)));
  return {
    trading_date: input.tradingDate,
    window_returns: levels.windowReturns,
    min_observations: levels.minObservations,
    overlap_warn: levels.overlapInstruments,
    correlation_warn: levels.correlation,
    books: books.map((book) => bookExposure(book, input.holdings)),
    holdings: input.holdings,
    overlaps: found,
    correlations: pairs,
    warnings: warnings(found, pairs, primaries, levels),
  };
}

export function newWarnings(
  report: CrossSleeveExposureWire,
  previous: readonly string[],
): string[] {
  const before = new Set(previous);
  return report.warnings.filter((warning) => !before.has(warning));
}

export interface ExposureJournal {
  equityThrough(tradingDate: string, dates: number): readonly EquityRow[];
  warningsBefore(tradingDate: string): readonly string[];
  record(report: CrossSleeveExposureWire): void;
}

export class SqliteExposureJournal implements ExposureJournal {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
  ) {}

  equityThrough(tradingDate: string, dates: number): readonly EquityRow[] {
    return this.db
      .prepare(
        `SELECT book_id, trading_date, equity_gbp FROM v2_book_days
          WHERE trading_date IN (SELECT DISTINCT trading_date FROM v2_book_days
                                  WHERE trading_date <= ? ORDER BY trading_date DESC LIMIT ?)
          ORDER BY book_id, trading_date`,
      )
      .all(tradingDate, dates) as EquityRow[];
  }

  warningsBefore(tradingDate: string): readonly string[] {
    const row = this.db
      .prepare(
        `SELECT report FROM v2_exposure_reports WHERE trading_date < ?
          ORDER BY trading_date DESC LIMIT 1`,
      )
      .get(tradingDate) as { report: string } | undefined;
    return row === undefined ? [] : (JSON.parse(row.report) as CrossSleeveExposureWire).warnings;
  }

  record(report: CrossSleeveExposureWire): void {
    this.db
      .prepare(
        `INSERT INTO v2_exposure_reports (trading_date, report, recorded_at)
         SELECT @date, @report, @at
          WHERE NOT EXISTS (SELECT 1 FROM v2_exposure_reports WHERE trading_date = @date)`,
      )
      .run({
        date: report.trading_date,
        report: JSON.stringify(report),
        at: toStoredTimestamp(this.clock.now()),
      });
  }
}

export function readLatestExposure(db: StoreHandle): PanelWire<CrossSleeveExposureWire> {
  const row = db
    .prepare('SELECT report FROM v2_exposure_reports ORDER BY trading_date DESC LIMIT 1')
    .get() as { report: string } | undefined;
  return row === undefined
    ? { status: 'empty' }
    : { status: 'fed', ...(JSON.parse(row.report) as CrossSleeveExposureWire) };
}
