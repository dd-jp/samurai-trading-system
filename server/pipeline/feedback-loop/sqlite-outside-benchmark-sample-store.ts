import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';
import type { OutsideBenchmarkId, OutsideBenchmarkSample } from '../outside-benchmark/index.js';
import type { OutsideBenchmarkSampleStore } from './types.js';

interface OutsideBenchmarkSampleRow {
  computed_at: string;
  benchmark: OutsideBenchmarkId;
  window_from: string;
  window_to: string;
  buy_and_hold_return_pct: number;
  max_drawdown_pct: number;
  observation_count: number;
}

const COLUMNS = `computed_at, benchmark, window_from, window_to,
                 buy_and_hold_return_pct, max_drawdown_pct, observation_count`;

function fromRow(row: OutsideBenchmarkSampleRow): OutsideBenchmarkSample {
  return {
    computed_at: fromStoredTimestamp(row.computed_at),
    from: fromStoredTimestamp(row.window_from),
    to: fromStoredTimestamp(row.window_to),
    performance: {
      benchmark: row.benchmark,
      buy_and_hold_return_pct: row.buy_and_hold_return_pct,
      max_drawdown_pct: row.max_drawdown_pct,
      observation_count: row.observation_count,
    },
  };
}

export class SqliteOutsideBenchmarkSampleStore implements OutsideBenchmarkSampleStore {
  constructor(private readonly db: StoreHandle) {}

  append(sample: OutsideBenchmarkSample): void {
    const { performance } = sample;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO outside_benchmark_samples (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        toStoredTimestamp(sample.computed_at),
        performance.benchmark,
        toStoredTimestamp(sample.from),
        toStoredTimestamp(sample.to),
        performance.buy_and_hold_return_pct,
        performance.max_drawdown_pct,
        performance.observation_count,
      );
  }

  getRecent(limit: number, asOf: Date): OutsideBenchmarkSample[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS}
           FROM outside_benchmark_samples
          WHERE computed_at <= ?
          ORDER BY computed_at DESC, benchmark ASC
          LIMIT ?`,
      )
      .all(toStoredTimestamp(asOf), limit) as OutsideBenchmarkSampleRow[];

    return rows.map(fromRow);
  }
}
