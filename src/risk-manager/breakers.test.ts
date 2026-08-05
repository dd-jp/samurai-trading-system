import type { Clock } from '../shared/index.js';
import type { BreakerConfig, BreakerEvalInput } from './breakers.js';
import { CircuitBreakers } from './breakers.js';
import type { DailyPnlByClass, PortfolioView } from './types.js';

/** Every class at the same known figure — the daily-loss breaker reads `portfolio`. */
function pnl(pct: number): DailyPnlByClass {
  const known = { known: true, pct } as const;
  return { crypto: known, stocks: known, portfolio: known };
}

function makeClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

function makePortfolio(overrides: Partial<PortfolioView> = {}): PortfolioView {
  return {
    equity: 100_000,
    peak_equity: 100_000,
    drawdown_pct: 0,
    exposure_by_instrument: {},
    exposure_by_class: { crypto: 0, stocks: 0 },
    gross_exposure: 0,
    daily_pnl: pnl(0),
    consecutive_losses: 0,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<BreakerConfig> = {}): BreakerConfig {
  return {
    daily_loss_pct: 3,
    max_drawdown_pct: 20,
    max_consecutive_losses: 4,
    volatility: {
      baseline: { crypto: 2, stocks: 1 },
      multiplier: 2,
    },
    auto_rearm: {
      recovery_drawdown_pct: 10,
      max_days_tripped: 5,
    },
    ...overrides,
  };
}

function makeInput(overrides: Partial<BreakerEvalInput> = {}): BreakerEvalInput {
  return {
    portfolio: makePortfolio(),
    volatility: { crypto: 1, stocks: 0.5 },
    mode: 'live',
    clock: makeClock('2026-07-15T09:30:00Z'),
    ...overrides,
  };
}

describe('CircuitBreakers', () => {
  it('is fully armed (no breakers tripped) when every metric is within threshold', () => {
    const breakers = new CircuitBreakers(makeConfig());
    const state = breakers.evaluate(makeInput());

    expect(state.portfolio_tripped).toBe(false);
    expect(state.asset_class_tripped).toEqual({ crypto: false, stocks: false });
    expect(state.armed_breakers).toEqual([]);
  });

  it('trips the daily-loss breaker at the portfolio tier once cumulative loss exceeds threshold', () => {
    const breakers = new CircuitBreakers(makeConfig({ daily_loss_pct: 3 }));

    const belowThreshold = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ daily_pnl: pnl(-2) }) }),
    );
    expect(belowThreshold.portfolio_tripped).toBe(false);

    const atThreshold = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ daily_pnl: pnl(-3.5) }) }),
    );
    expect(atThreshold.portfolio_tripped).toBe(true);
    expect(atThreshold.armed_breakers).toContain('daily_loss_soft');
  });

  it('auto-resets the daily-loss breaker once daily PnL recovers (soft, stateless)', () => {
    const breakers = new CircuitBreakers(makeConfig({ daily_loss_pct: 3 }));
    breakers.evaluate(makeInput({ portfolio: makePortfolio({ daily_pnl: pnl(-5) }) }));

    const recovered = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ daily_pnl: pnl(0) }) }),
    );
    expect(recovered.portfolio_tripped).toBe(false);
  });

  it('arms daily_pnl_unknown, without halting, when the daily figure is unknown', () => {
    const breakers = new CircuitBreakers(makeConfig({ daily_loss_pct: 3 }));
    const unknown = { known: false, reason: 'no session-open equity observed' } as const;

    const state = breakers.evaluate(
      makeInput({
        portfolio: makePortfolio({
          daily_pnl: { crypto: unknown, stocks: unknown, portfolio: unknown },
        }),
      }),
    );

    // Visible in the audit trail and the operator's breaker summary — the
    // #293/#320/#324/#342 posture that a degraded state is never reached
    // quietly.
    expect(state.armed_breakers).toContain('daily_pnl_unknown');
    // But NOT a halt: escalating unknown to a block on new entries is #333's
    // two-tier daily-loss work, which owns the re-arm semantics. Arming a name
    // this breaker cannot itself clear would strand the system halted.
    expect(state.portfolio_tripped).toBe(false);
    expect(state.armed_breakers).not.toContain('daily_loss_soft');
  });

  it('does not read an unknown daily figure as a flat day', () => {
    const breakers = new CircuitBreakers(makeConfig({ daily_loss_pct: 0.05 }));
    const unknown = { known: false, reason: 'restart after the boundary' } as const;

    const state = breakers.evaluate(
      makeInput({
        portfolio: makePortfolio({
          daily_pnl: { crypto: unknown, stocks: unknown, portfolio: unknown },
        }),
      }),
    );

    // A `null`/`undefined` here would coerce to 0 in `pct <= -0.05` and be
    // indistinguishable from a genuinely flat session. The union makes the
    // absence explicit instead.
    expect(state.armed_breakers).toEqual(['daily_pnl_unknown']);
  });

  it('leaves daily_pnl_unknown unarmed when the figure is known', () => {
    const breakers = new CircuitBreakers(makeConfig({ daily_loss_pct: 3 }));

    const state = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ daily_pnl: pnl(-1) }) }),
    );

    expect(state.armed_breakers).not.toContain('daily_pnl_unknown');
  });

  it('trips the consecutive-loss cooldown at the portfolio tier at the configured count', () => {
    const breakers = new CircuitBreakers(makeConfig({ max_consecutive_losses: 4 }));

    const belowThreshold = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ consecutive_losses: 3 }) }),
    );
    expect(belowThreshold.portfolio_tripped).toBe(false);

    const atThreshold = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ consecutive_losses: 4 }) }),
    );
    expect(atThreshold.portfolio_tripped).toBe(true);
    expect(atThreshold.armed_breakers).toContain('consecutive_loss_cooldown');
  });

  it('trips the hard peak-to-trough drawdown breaker and it stays tripped even if drawdown recovers', () => {
    const breakers = new CircuitBreakers(makeConfig({ max_drawdown_pct: 20 }));

    const belowThreshold = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ drawdown_pct: 15 }) }),
    );
    expect(belowThreshold.portfolio_tripped).toBe(false);

    const tripped = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ drawdown_pct: 22 }) }),
    );
    expect(tripped.portfolio_tripped).toBe(true);
    expect(tripped.armed_breakers).toContain('portfolio_drawdown_hard');

    const recoveredButStillTripped = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ drawdown_pct: 2 }) }),
    );
    expect(recoveredButStillTripped.portfolio_tripped).toBe(true);
    expect(recoveredButStillTripped.armed_breakers).toContain('portfolio_drawdown_hard');
  });

  it('requires a manual reArm() to clear the hard drawdown breaker in live mode', () => {
    const breakers = new CircuitBreakers(makeConfig({ max_drawdown_pct: 20 }));
    breakers.evaluate(makeInput({ portfolio: makePortfolio({ drawdown_pct: 25 }) }));

    const stillTripped = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ drawdown_pct: 0 }), mode: 'live' }),
    );
    expect(stillTripped.portfolio_tripped).toBe(true);

    breakers.reArm();
    const cleared = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ drawdown_pct: 0 }), mode: 'live' }),
    );
    expect(cleared.portfolio_tripped).toBe(false);
  });

  it('requires a manual reArm() to clear the hard drawdown breaker in paper mode', () => {
    const breakers = new CircuitBreakers(makeConfig({ max_drawdown_pct: 20 }));
    breakers.evaluate(makeInput({ portfolio: makePortfolio({ drawdown_pct: 25 }), mode: 'paper' }));

    const stillTripped = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ drawdown_pct: 0 }), mode: 'paper' }),
    );
    expect(stillTripped.portfolio_tripped).toBe(true);

    breakers.reArm();
    const cleared = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ drawdown_pct: 0 }), mode: 'paper' }),
    );
    expect(cleared.portfolio_tripped).toBe(false);
  });

  it('does not auto-re-arm the hard breaker in paper mode even if the recovery condition is met', () => {
    const config = makeConfig({
      max_drawdown_pct: 20,
      auto_rearm: { recovery_drawdown_pct: 10, max_days_tripped: 1 },
    });
    const breakers = new CircuitBreakers(config);
    breakers.evaluate(
      makeInput({
        portfolio: makePortfolio({ drawdown_pct: 25 }),
        mode: 'paper',
        clock: makeClock('2026-07-01T00:00:00Z'),
      }),
    );

    const stillTripped = breakers.evaluate(
      makeInput({
        portfolio: makePortfolio({ drawdown_pct: 0 }),
        mode: 'paper',
        clock: makeClock('2026-08-01T00:00:00Z'),
      }),
    );
    expect(stillTripped.portfolio_tripped).toBe(true);
  });

  it('auto-re-arms the hard drawdown breaker under the backtest mode flag once recovered', () => {
    const config = makeConfig({
      max_drawdown_pct: 20,
      auto_rearm: { recovery_drawdown_pct: 10, max_days_tripped: 999 },
    });
    const breakers = new CircuitBreakers(config);
    breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ drawdown_pct: 25 }), mode: 'backtest' }),
    );

    const stillAboveRecovery = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ drawdown_pct: 15 }), mode: 'backtest' }),
    );
    expect(stillAboveRecovery.portfolio_tripped).toBe(true);

    const recovered = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ drawdown_pct: 5 }), mode: 'backtest' }),
    );
    expect(recovered.portfolio_tripped).toBe(false);
  });

  it('auto-re-arms the hard drawdown breaker in backtest mode after the configured day timeout', () => {
    const config = makeConfig({
      max_drawdown_pct: 20,
      auto_rearm: { recovery_drawdown_pct: 0, max_days_tripped: 3 },
    });
    const breakers = new CircuitBreakers(config);
    breakers.evaluate(
      makeInput({
        portfolio: makePortfolio({ drawdown_pct: 25 }),
        mode: 'backtest',
        clock: makeClock('2026-07-01T00:00:00Z'),
      }),
    );

    const beforeTimeout = breakers.evaluate(
      makeInput({
        portfolio: makePortfolio({ drawdown_pct: 25 }),
        mode: 'backtest',
        clock: makeClock('2026-07-02T00:00:00Z'),
      }),
    );
    expect(beforeTimeout.portfolio_tripped).toBe(true);

    const afterTimeout = breakers.evaluate(
      makeInput({
        portfolio: makePortfolio({ drawdown_pct: 25 }),
        mode: 'backtest',
        clock: makeClock('2026-07-05T00:00:00Z'),
      }),
    );
    expect(afterTimeout.portfolio_tripped).toBe(false);
  });

  it('does not auto-re-arm the hard breaker in live mode even if the recovery condition is met', () => {
    const config = makeConfig({
      max_drawdown_pct: 20,
      auto_rearm: { recovery_drawdown_pct: 10, max_days_tripped: 1 },
    });
    const breakers = new CircuitBreakers(config);
    breakers.evaluate(
      makeInput({
        portfolio: makePortfolio({ drawdown_pct: 25 }),
        mode: 'live',
        clock: makeClock('2026-07-01T00:00:00Z'),
      }),
    );

    const stillTripped = breakers.evaluate(
      makeInput({
        portfolio: makePortfolio({ drawdown_pct: 0 }),
        mode: 'live',
        clock: makeClock('2026-08-01T00:00:00Z'),
      }),
    );
    expect(stillTripped.portfolio_tripped).toBe(true);
  });

  it('trips the per-asset-class volatility halt independently for crypto vs stocks', () => {
    const breakers = new CircuitBreakers(makeConfig());

    const cryptoSpike = breakers.evaluate(makeInput({ volatility: { crypto: 5, stocks: 0.5 } }));
    expect(cryptoSpike.asset_class_tripped).toEqual({ crypto: true, stocks: false });
    expect(cryptoSpike.portfolio_tripped).toBe(false);
    expect(cryptoSpike.armed_breakers).toContain('volatility_halt:crypto');

    const stocksSpike = breakers.evaluate(makeInput({ volatility: { crypto: 1, stocks: 3 } }));
    expect(stocksSpike.asset_class_tripped).toEqual({ crypto: false, stocks: true });
    expect(stocksSpike.armed_breakers).toContain('volatility_halt:stocks');
  });

  it('auto-resets the volatility halt once the reading falls back below baseline * multiplier', () => {
    const breakers = new CircuitBreakers(makeConfig());
    breakers.evaluate(makeInput({ volatility: { crypto: 10, stocks: 0.5 } }));

    const recovered = breakers.evaluate(makeInput({ volatility: { crypto: 1, stocks: 0.5 } }));
    expect(recovered.asset_class_tripped.crypto).toBe(false);
  });

  it('engages and releases the kill-switch at the portfolio tier, persisting until released', () => {
    const breakers = new CircuitBreakers(makeConfig());
    breakers.engageKillSwitch('dead-mans-switch');

    const engaged = breakers.evaluate(makeInput());
    expect(engaged.portfolio_tripped).toBe(true);
    expect(engaged.armed_breakers).toContain('kill_switch:dead-mans-switch');

    breakers.releaseKillSwitch();
    const released = breakers.evaluate(makeInput());
    expect(released.portfolio_tripped).toBe(false);
    expect(released.armed_breakers).not.toContain('kill_switch:dead-mans-switch');
  });
});

describe('CircuitBreakers — crash-restart persistence (#203)', () => {
  it('reports untripped/disengaged persisted state when nothing has tripped', () => {
    const breakers = new CircuitBreakers(makeConfig());
    breakers.evaluate(makeInput());

    expect(breakers.getPersistedState()).toEqual([
      {
        tier: 'portfolio_drawdown',
        tripped: false,
        tripped_at: null,
        reset_at: null,
        reason: null,
      },
      { tier: 'kill_switch', tripped: false, tripped_at: null, reset_at: null, reason: null },
    ]);
  });

  it('survives a fresh CircuitBreakers instance constructed from a persisted hard-drawdown trip', () => {
    const config = makeConfig({ max_drawdown_pct: 20 });
    const before = new CircuitBreakers(config);
    before.evaluate(
      makeInput({
        portfolio: makePortfolio({ drawdown_pct: 25 }),
        clock: makeClock('2026-07-10T00:00:00Z'),
      }),
    );

    const persisted = before.getPersistedState();
    expect(persisted).toEqual([
      {
        tier: 'portfolio_drawdown',
        tripped: true,
        tripped_at: new Date('2026-07-10T00:00:00Z'),
        reset_at: null,
        reason: 'portfolio_drawdown_hard',
      },
      { tier: 'kill_switch', tripped: false, tripped_at: null, reset_at: null, reason: null },
    ]);

    // Simulates a process restart: a brand-new instance, seeded only from the persisted rows.
    const after = new CircuitBreakers(config, persisted);
    const stillTripped = after.evaluate(
      makeInput({ portfolio: makePortfolio({ drawdown_pct: 0 }), mode: 'live' }),
    );

    expect(stillTripped.portfolio_tripped).toBe(true);
    expect(stillTripped.armed_breakers).toContain('portfolio_drawdown_hard');
    expect(after.getPersistedState()).toEqual(persisted);
  });

  it('survives a fresh CircuitBreakers instance constructed from a persisted kill-switch engagement', () => {
    const config = makeConfig();
    const before = new CircuitBreakers(config);
    before.engageKillSwitch('dead-mans-switch');

    const persisted = before.getPersistedState();
    expect(persisted).toContainEqual({
      tier: 'kill_switch',
      tripped: true,
      tripped_at: null,
      reset_at: null,
      reason: 'dead-mans-switch',
    });

    const after = new CircuitBreakers(config, persisted);
    const engaged = after.evaluate(makeInput());

    expect(engaged.portfolio_tripped).toBe(true);
    expect(engaged.armed_breakers).toContain('kill_switch:dead-mans-switch');
  });

  it('a re-armed/released breaker persists as cleared for the next restart', () => {
    const config = makeConfig({ max_drawdown_pct: 20 });
    const before = new CircuitBreakers(config);
    before.evaluate(makeInput({ portfolio: makePortfolio({ drawdown_pct: 25 }) }));
    before.reArm();

    const persisted = before.getPersistedState();
    const after = new CircuitBreakers(config, persisted);
    const cleared = after.evaluate(makeInput({ portfolio: makePortfolio({ drawdown_pct: 0 }) }));

    expect(cleared.portfolio_tripped).toBe(false);
  });
});
