import { createHash } from 'node:crypto';
import type { BarSeries } from '../../pipeline/momentum/index.js';
import type { Clock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';
import { type BarsSource, barsBefore, type CfdCatalogue } from './data/index.js';

export const CFD_CATALOGUE_DIGEST_NAME = 'saxo-cfd-catalogue';

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
  readonly #read = new Set<string>();

  constructor(private readonly inner: BarsSource) {}

  load(symbol: string): BarSeries | undefined {
    this.#read.add(symbol);
    return this.inner.load(symbol);
  }

  clear(): void {
    this.#read.clear();
  }

  names(): readonly string[] {
    return [...this.#read].sort();
  }
}

export function barWindowDigest(
  name: string,
  series: BarSeries | undefined,
  tradingDate: string,
): InputDigest {
  const window = series === undefined ? [] : barsBefore(series, tradingDate);
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
  names: readonly string[],
  catalogue: CfdCatalogue | undefined,
  tradingDate: string,
): InputDigest[] {
  return [
    ...names.map((name) => barWindowDigest(name, bars.load(name), tradingDate)),
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

function currentDigest(
  journalled: InputDigest,
  bars: BarsSource,
  catalogue: CfdCatalogue | undefined,
  tradingDate: string,
): InputDigest {
  return journalled.input === 'bars'
    ? barWindowDigest(journalled.name, bars.load(journalled.name), tradingDate)
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
