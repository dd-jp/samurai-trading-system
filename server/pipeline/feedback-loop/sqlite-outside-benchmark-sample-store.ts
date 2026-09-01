/**
 * SQLite-backed `OutsideBenchmarkSampleStore` over `outside_benchmark_samples`
 * (migration 0036, #981) — FL's own record of every outside benchmark it
 * measured, over the matched control's own window.
 *
 * Written by the orchestrator's daily feedback cycle, read by the dashboard's
 * query store in the OTHER process. That split is why this is persisted at all
 * rather than recomputed on read — see the migration's own comment, and
 * `SqliteArmComparisonSampleStore`, which this mirrors.
 */
import type { SharedStore } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/sqlite-utils.js';
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
  constructor(private readonly db: SharedStore) {}

  /**
   * One row per (cycle instant, benchmark). `INSERT OR REPLACE` for the reason
   * the arm store uses it: a restart that re-runs the same cycle instant is
   * re-measuring the same window, and the newer computation is the truthful
   * row — but it must not become a SECOND point in the trend, which is what the
   * composite primary key prevents.
   */
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

  /**
   * Most-recently-computed first, bounded by `asOf` like every other dashboard
   * read — a snapshot must never show a sample computed after the instant it
   * claims to describe.
   *
   * `limit` counts ROWS, not cycles: with two benchmarks a limit of 10 is five
   * cycles' worth. The caller sizes it knowing that, the same way it sizes the
   * arm trend, and the secondary `benchmark` sort keeps a cycle's rows adjacent
   * and in a stable order rather than at SQLite's discretion.
   */
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
