import { openSharedStore, type StoreHandle } from '../../shared/store/index.js';
import { type BreakerConfig, CircuitBreakers } from './breakers.js';
import { SqliteBreakerStateStore } from './sqlite-breaker-state-store.js';
import type { PersistedBreakerState } from './types.js';

function makeDb(): StoreHandle {
  return openSharedStore(':memory:');
}

const TRIPPED_AT = new Date('2026-08-06T10:00:00Z');

function trippedState(): PersistedBreakerState[] {
  return [
    {
      tier: 'portfolio_drawdown',
      tripped: true,
      tripped_at: TRIPPED_AT,
      reset_at: null,
      reason: null,
    },
    { tier: 'kill_switch', tripped: true, tripped_at: null, reset_at: null, reason: 'manual halt' },
  ];
}

describe('SqliteBreakerStateStore', () => {
  it('returns undefined from an empty table, so a first boot starts untripped by default', () => {
    const store = new SqliteBreakerStateStore(makeDb());
    expect(store.load()).toBeUndefined();
  });

  it('round-trips both tiers losslessly, upserting on re-save', () => {
    const store = new SqliteBreakerStateStore(makeDb());

    store.save(trippedState());
    expect(store.load()).toEqual(trippedState());

    const cleared: PersistedBreakerState[] = [
      {
        tier: 'portfolio_drawdown',
        tripped: false,
        tripped_at: null,
        reset_at: TRIPPED_AT,
        reason: null,
      },
      { tier: 'kill_switch', tripped: false, tripped_at: null, reset_at: null, reason: null },
    ];
    store.save(cleared);
    expect(store.load()).toEqual(cleared);
  });

  it('a tripped breaker survives a restart: reconstructing CircuitBreakers from load() reports it tripped', () => {
    const db = makeDb();
    const store = new SqliteBreakerStateStore(db);
    store.save(trippedState());

    // "Restart": a fresh store over the same file, a fresh CircuitBreakers
    // from what it loads — the exact boot path buildProductionComponents takes.
    const config: BreakerConfig = {
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.2,
      max_consecutive_losses: 5,
      volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
      auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
    };
    const rebuilt = new CircuitBreakers(config, new SqliteBreakerStateStore(db).load());

    const persisted = rebuilt.getPersistedState();
    const byTier = new Map(persisted.map((row) => [row.tier, row]));
    expect(byTier.get('portfolio_drawdown')?.tripped).toBe(true);
    expect(byTier.get('kill_switch')?.tripped).toBe(true);
    expect(byTier.get('kill_switch')?.reason).toBe('manual halt');
  });
});
