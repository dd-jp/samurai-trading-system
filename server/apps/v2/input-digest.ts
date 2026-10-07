import { createHash } from 'node:crypto';
import type { BarSeries, Clock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';
import { type BarsSource, barsBefore, type CfdCatalogue } from './data/index.js';
import { MEAN_REVERSION_LOOKBACK_BARS, SMA_LONG_WINDOW } from './signal/index.js';

export const CFD_CATALOGUE_DIGEST_NAME = 'saxo-cfd-catalogue';

// Readers that take a whole series rather than a counted window look back at most this far: the
// debate technical read its 200-session SMA, and a candidate's session-calendar coverage check
// its own look-back (mean reversion's is the deepest; cross-asset trend's is 210)
export const DIGEST_FLOOR_BARS = Math.max(SMA_LONG_WINDOW, MEAN_REVERSION_LOOKBACK_BARS);

const BAR_FIELDS = 6;

export type DigestedInput = 'bars' | 'cfd_catalogue';

export interface InputDigest {
  readonly input: DigestedInput;
  readonly name: string;
  readonly sha256: string | null;
  readonly first_bar_date: string | null;
  readonly last_bar_date: string | null;
  readonly row_count: number | null;
  readonly as_of: string | null;
}

export class RecordingBarsSource implements BarsSource {
  readonly #windows = new Map<string, number>();

  constructor(private readonly inner: BarsSource) {}

  load(symbol: string): BarSeries | undefined {
    this.noteWindow(symbol, DIGEST_FLOOR_BARS);
    return this.inner.load(symbol);
  }

  noteWindow(symbol: string, bars: number): void {
    this.#windows.set(symbol, Math.max(bars, this.#windows.get(symbol) ?? 0));
  }

  clear(): void {
    this.#windows.clear();
  }

  windows(): ReadonlyMap<string, number> {
    return new Map([...this.#windows].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
}

export function barWindowDigest(
  name: string,
  series: BarSeries | undefined,
  tradingDate: string,
  windowBars: number,
): InputDigest {
  const window = series === undefined ? [] : barsBefore(series, tradingDate).slice(-windowBars);
  // Host byte order: every host the root runs on (x86-64, Apple silicon) is little-endian
  const values = new Float64Array(window.length * BAR_FIELDS);
  window.forEach((bar, index) => {
    values.set(
      [bar.open, bar.high, bar.low, bar.close, bar.volume, bar.rawClose],
      index * BAR_FIELDS,
    );
  });
  const sha256 = createHash('sha256')
    .update(window.map((bar) => bar.date).join(','))
    .update(new Uint8Array(values.buffer))
    .digest('hex');
  return {
    input: 'bars',
    name,
    sha256,
    first_bar_date: window[0]?.date ?? null,
    last_bar_date: window.at(-1)?.date ?? null,
    row_count: window.length,
    as_of: null,
  };
}

export function catalogueDigest(catalogue: CfdCatalogue | undefined): InputDigest {
  return {
    input: 'cfd_catalogue',
    name: CFD_CATALOGUE_DIGEST_NAME,
    sha256: catalogue?.sha256 ?? null,
    first_bar_date: null,
    last_bar_date: null,
    row_count: null,
    as_of: catalogue?.asOf ?? null,
  };
}

export function cycleInputDigests(
  bars: BarsSource,
  windows: ReadonlyMap<string, number>,
  catalogue: CfdCatalogue | undefined,
  tradingDate: string,
): InputDigest[] {
  return [
    ...[...windows].map(([name, windowBars]) =>
      barWindowDigest(name, bars.load(name), tradingDate, windowBars),
    ),
    catalogueDigest(catalogue),
  ];
}

const INSERT_SQL = `
  INSERT INTO v2_input_digests (trading_date, input, name, sha256, first_bar_date, last_bar_date,
    row_count, as_of, recorded_at)
  VALUES (@trading_date, @input, @name, @sha256, @first_bar_date, @last_bar_date, @row_count,
    @as_of, @recorded_at)`;

export function recordInputDigests(
  db: StoreHandle,
  clock: Clock,
  tradingDate: string,
  digests: readonly InputDigest[],
): void {
  const insert = db.prepare(INSERT_SQL);
  const recordedAt = toStoredTimestamp(clock.now());
  db.transaction(() => {
    for (const row of digests) {
      insert.run({ ...row, trading_date: tradingDate, recorded_at: recordedAt });
    }
  })();
}

// A read-only store is never migrated, so one last migrated before #1982 has no digest table
function hasDigestTable(db: StoreHandle): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'v2_input_digests'")
      .get() !== undefined
  );
}

export function journalledInputDigests(db: StoreHandle, tradingDate: string): InputDigest[] {
  if (!hasDigestTable(db)) return [];
  return db
    .prepare(
      `SELECT input, name, sha256, first_bar_date, last_bar_date, row_count, as_of
         FROM v2_input_digests WHERE trading_date = ? ORDER BY digest_id`,
    )
    .all(tradingDate) as InputDigest[];
}

export interface InputChange {
  readonly journalled: InputDigest;
  readonly current: InputDigest;
}

// A window shorter than the floor held the name's whole history, so older bars added since are
// a change; a digest from before the window (#2028) covered the whole history, which this reproduces
function replayedWindowBars(journalled: InputDigest): number {
  return Math.max(journalled.row_count ?? 0, DIGEST_FLOOR_BARS);
}

function currentDigest(
  journalled: InputDigest,
  bars: BarsSource,
  catalogue: CfdCatalogue | undefined,
  tradingDate: string,
): InputDigest {
  return journalled.input === 'bars'
    ? barWindowDigest(
        journalled.name,
        bars.load(journalled.name),
        tradingDate,
        replayedWindowBars(journalled),
      )
    : catalogueDigest(catalogue);
}

export function inputChangesSince(
  db: StoreHandle,
  tradingDate: string,
  bars: BarsSource,
  catalogue: CfdCatalogue | undefined,
): InputChange[] {
  return journalledInputDigests(db, tradingDate)
    .map((journalled) => ({
      journalled,
      current: currentDigest(journalled, bars, catalogue, tradingDate),
    }))
    .filter(({ journalled, current }) => journalled.sha256 !== current.sha256);
}
