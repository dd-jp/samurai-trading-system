import type { Clock } from '../shared/index.js';
import { openSharedStore } from '../shared/store/index.js';
import { SqliteTuningStore } from './sqlite-tuning-store.js';

const NOW = new Date('2026-07-19T00:00:00Z');

function makeClock(at: Date = NOW): Clock {
  return { now: () => at };
}

function makeStore(clock: Clock = makeClock()) {
  const db = openSharedStore(':memory:');
  return { db, store: new SqliteTuningStore(db, clock) };
}

describe('SqliteTuningStore — analyst weights', () => {
  it('reads back nothing before any write', () => {
    const { store } = makeStore();
    expect(store.getAnalystWeights()).toEqual({});
  });

  it('setAnalystWeight inserts a row keyed by analyst_id', () => {
    const { db, store } = makeStore();

    store.setAnalystWeight('bull', 0.6);

    expect(db.prepare('SELECT * FROM analyst_weights').all()).toEqual([
      { analyst_id: 'bull', weight: 0.6, updated_at: NOW.toISOString() },
    ]);
    expect(store.getAnalystWeights()).toEqual({ bull: 0.6 });
  });

  it('setAnalystWeight on an existing analyst_id overwrites in place, bumping updated_at', () => {
    const later = new Date('2026-07-20T00:00:00Z');
    const { db, store } = makeStore(makeClock(NOW));

    store.setAnalystWeight('bull', 0.6);
    const laterStore = new SqliteTuningStore(db, makeClock(later));
    laterStore.setAnalystWeight('bull', 0.75);

    expect(db.prepare('SELECT COUNT(*) AS n FROM analyst_weights').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT * FROM analyst_weights').get()).toEqual({
      analyst_id: 'bull',
      weight: 0.75,
      updated_at: later.toISOString(),
    });
  });

  it('getAnalystWeights returns every analyst as a plain map', () => {
    const { store } = makeStore();
    store.setAnalystWeight('bull', 0.6);
    store.setAnalystWeight('bear', 0.4);

    expect(store.getAnalystWeights()).toEqual({ bull: 0.6, bear: 0.4 });
  });
});

describe('SqliteTuningStore — strategy params', () => {
  it('round-trips a strategy param through set/get', () => {
    const { store } = makeStore();
    store.setStrategyParam('conviction_multiplier', 1.2);

    expect(store.getStrategyParams()).toEqual({ conviction_multiplier: 1.2 });
  });

  it('overwrites an existing param in place', () => {
    const { db, store } = makeStore();
    store.setStrategyParam('conviction_multiplier', 1.2);
    store.setStrategyParam('conviction_multiplier', 1.5);

    expect(db.prepare('SELECT COUNT(*) AS n FROM strategy_params').get()).toEqual({ n: 1 });
    expect(store.getStrategyParams()).toEqual({ conviction_multiplier: 1.5 });
  });
});

describe('SqliteTuningStore — risk thresholds', () => {
  it('round-trips a risk threshold through set/get', () => {
    const { store } = makeStore();
    store.setRiskThreshold('max_position_size', 1000);

    expect(store.getRiskThresholds()).toEqual({ max_position_size: 1000 });
  });

  it('overwrites an existing threshold in place', () => {
    const { db, store } = makeStore();
    store.setRiskThreshold('max_position_size', 1000);
    store.setRiskThreshold('max_position_size', 800);

    expect(db.prepare('SELECT COUNT(*) AS n FROM risk_thresholds').get()).toEqual({ n: 1 });
    expect(store.getRiskThresholds()).toEqual({ max_position_size: 800 });
  });
});

describe('SqliteTuningStore — dial isolation', () => {
  it('keeps the three dial tables independent even when names collide', () => {
    const { store } = makeStore();
    store.setAnalystWeight('shared_name', 1);
    store.setStrategyParam('shared_name', 2);
    store.setRiskThreshold('shared_name', 3);

    expect(store.getAnalystWeights()).toEqual({ shared_name: 1 });
    expect(store.getStrategyParams()).toEqual({ shared_name: 2 });
    expect(store.getRiskThresholds()).toEqual({ shared_name: 3 });
  });
});
