/**
 * The frozen-selection store (#375, #384).
 *
 * The property with teeth is append-only: a Stage 2 re-run is evidence about a
 * different sample, and the previous verdict is the record of what was believed
 * when a capital decision was made.
 */
import { openSharedStore, type SharedStore } from '../../shared/store/index.js';
import { SqliteStage2SelectionStore } from './sqlite-stage2-selection-store.js';
import type { Stage2Selection } from './stage2-selection.js';

function selection(overrides: Partial<Stage2Selection> = {}): Stage2Selection {
  return {
    config_hash: 'cfg-a',
    asset_class: 'crypto',
    selected_at: new Date('2026-08-06T09:00:00Z'),
    window: { start: new Date('2024-01-01T00:00:00Z'), end: new Date('2026-01-01T00:00:00Z') },
    backtest_sharpe: 1.4,
    oos_sharpe: 0.9,
    fold_sharpes: [0.8, 1.0],
    pbo: 0.2,
    dsr: 0.42,
    n_trials: 24,
    overall_pass: false,
    ...overrides,
  };
}

describe('SqliteStage2SelectionStore', () => {
  let db: SharedStore;
  let store: SqliteStage2SelectionStore;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    store = new SqliteStage2SelectionStore(db);
  });

  it('round-trips every field, including the fold distribution', () => {
    store.record(selection());

    expect(store.getLatest('crypto')).toEqual(selection());
  });

  it('answers null for an asset class Stage 2 has never run for', () => {
    store.record(selection({ asset_class: 'crypto' }));

    expect(store.getLatest('stocks')).toBeNull();
  });

  it('keeps a refused PBO or DSR as null, never as zero', () => {
    // A stored 0.0 PBO reads as a perfect result and a stored 0.0 DSR reads as
    // certain insignificance — both would drive real risk configuration.
    store.record(selection({ pbo: null, dsr: null }));

    const stored = store.getLatest('crypto');
    expect(stored?.pbo).toBeNull();
    expect(stored?.dsr).toBeNull();
  });

  it('returns the NEWEST selection and keeps the older one', () => {
    const older = selection({ selected_at: new Date('2026-01-01T00:00:00Z'), backtest_sharpe: 2 });
    const newer = selection({ selected_at: new Date('2026-08-06T09:00:00Z'), backtest_sharpe: 1 });
    store.record(older);
    store.record(newer);

    expect(store.getLatest('crypto')?.backtest_sharpe).toBe(1);
    // History survives: the previous verdict is the record of what was believed
    // when the capital decision was made.
    expect(db.prepare('SELECT COUNT(*) AS n FROM stage2_selected_config').get()).toEqual({ n: 2 });
  });

  it('ignores a repeat of the same run rather than rewriting it', () => {
    store.record(selection());
    store.record(selection({ backtest_sharpe: 99 }));

    expect(store.getLatest('crypto')?.backtest_sharpe).toBe(1.4);
  });

  it('reports at most one row per asset class', () => {
    store.record(selection({ asset_class: 'crypto' }));
    store.record(selection({ asset_class: 'stocks', config_hash: 'cfg-c' }));
    store.record(
      selection({ asset_class: 'stocks', config_hash: 'cfg-d', selected_at: new Date(0) }),
    );

    const latest = store.getLatestPerAssetClass();
    expect(latest.map((row) => row.asset_class)).toEqual(['crypto', 'stocks']);
    expect(latest[1]?.config_hash).toBe('cfg-c');
  });

  it('reports nothing at all on a fresh store', () => {
    expect(store.getLatestPerAssetClass()).toEqual([]);
  });
});
