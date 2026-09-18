
import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';
import type { Stage2Selection } from './stage2-selection.js';

interface SelectionRow {
  config_hash: string;
  asset_class: 'crypto' | 'stocks';
  selected_at: string;
  window_start: string;
  window_end: string;
  backtest_sharpe: number;
  oos_sharpe: number;
  fold_sharpes_json: string;
  pbo: number | null;
  dsr: number | null;
  n_trials: number;
  overall_pass: number;
}

export class SqliteStage2SelectionStore {
  constructor(private readonly db: StoreHandle) {}

  record(selection: Stage2Selection): void {
    this.db
      .prepare(
        `INSERT INTO stage2_selected_config (
           config_hash, asset_class, selected_at, window_start, window_end,
           backtest_sharpe, oos_sharpe, fold_sharpes_json, pbo, dsr, n_trials, overall_pass
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(config_hash, asset_class, selected_at) DO NOTHING`,
      )
      .run(
        selection.config_hash,
        selection.asset_class,
        toStoredTimestamp(selection.selected_at),
        toStoredTimestamp(selection.window.start),
        toStoredTimestamp(selection.window.end),
        selection.backtest_sharpe,
        selection.oos_sharpe,
        JSON.stringify(selection.fold_sharpes),
        selection.pbo,
        selection.dsr,
        selection.n_trials,
        selection.overall_pass ? 1 : 0,
      );
  }

  getLatest(asset_class: 'crypto' | 'stocks'): Stage2Selection | null {
    const row = this.db
      .prepare(
        `SELECT * FROM stage2_selected_config
          WHERE asset_class = ?
          ORDER BY selected_at DESC
          LIMIT 1`,
      )
      .get(asset_class) as SelectionRow | undefined;

    return row === undefined ? null : toSelection(row);
  }

  getLatestPerAssetClass(): Stage2Selection[] {
    return (['crypto', 'stocks'] as const)
      .map((asset_class) => this.getLatest(asset_class))
      .filter((selection): selection is Stage2Selection => selection !== null);
  }
}

function toSelection(row: SelectionRow): Stage2Selection {
  return {
    config_hash: row.config_hash,
    asset_class: row.asset_class,
    selected_at: fromStoredTimestamp(row.selected_at),
    window: {
      start: fromStoredTimestamp(row.window_start),
      end: fromStoredTimestamp(row.window_end),
    },
    backtest_sharpe: row.backtest_sharpe,
    oos_sharpe: row.oos_sharpe,
    fold_sharpes: JSON.parse(row.fold_sharpes_json) as number[],
    pbo: row.pbo,
    dsr: row.dsr,
    n_trials: row.n_trials,
    overall_pass: row.overall_pass === 1,
  };
}
