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
    // Higher than the portfolio tier in the fixture, so the two tiers are
    // separable in tests: a portfolio-tier breach does not incidentally trip
    // the class tier, and a class-tier breach has to be set up deliberately.
    daily_loss_pct_by_class: { crypto: 5, stocks: 5 },
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

  it('HALTS new entries when the daily figure is unknown, and names why (#333)', () => {
    const breakers = new CircuitBreakers(makeConfig({ daily_loss_pct: 3 }));
    const unknown = { known: false, reason: 'no session-open equity observed' } as const;

    const state = breakers.evaluate(
      makeInput({
        portfolio: makePortfolio({
          daily_pnl: { crypto: unknown, stocks: unknown, portfolio: unknown },
        }),
      }),
    );

    // #332 left this advisory-only because it had no re-arm story. #333 supplies
    // one — the tier is non-sticky, so this clears itself at the next boundary
    // this process is up for — and decision 5 escalates it to a block.
    expect(state.portfolio_tripped).toBe(true);
    // Every tier is halted, not just the portfolio one: a class whose own
    // figure is unknown must not keep trading on the strength of the other's.
    expect(state.asset_class_tripped).toEqual({ crypto: true, stocks: true });

    // Still visible in the audit trail with its reason — the #293/#320/#324/#342
    // posture that a degraded state is never reached quietly. The reason is
    // carried through because a halted session has to be diagnosable without
    // reading code.
    expect(state.armed_breakers).toEqual([
      'daily_pnl_unknown:portfolio (no session-open equity observed)',
      'daily_pnl_unknown:crypto (no session-open equity observed)',
      'daily_pnl_unknown:stocks (no session-open equity observed)',
    ]);
    // A halt for a REASON, not a threshold breach — the loss breaker itself
    // never fired, and the operator summary must not suggest it did.
    expect(state.armed_breakers.some((name) => name.startsWith('daily_loss_soft'))).toBe(false);
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
    // indistinguishable from a genuinely flat session — which, post-#333, is
    // the difference between halting and trading on. The union makes the
    // absence explicit instead.
    expect(state.armed_breakers.every((name) => name.startsWith('daily_pnl_unknown:'))).toBe(true);
    expect(state.portfolio_tripped).toBe(true);
  });

  it('halts ONE class on an unknown of its OWN, leaving the other tradeable (#333)', () => {
    // The surgical property for the unknown tier, which the all-three-unknown
    // test above cannot show: an unknown is per-tier, not a global stop. Only
    // crypto's figure is missing here, so only crypto is halted — stocks has a
    // real number and keeps trading, and the portfolio floor is untouched.
    const breakers = new CircuitBreakers(makeConfig());

    const state = breakers.evaluate(
      makeInput({
        portfolio: makePortfolio({
          daily_pnl: {
            crypto: { known: false, reason: 'no crypto session-open equity observed' },
            stocks: { known: true, pct: -1 },
            portfolio: { known: true, pct: -1 },
          },
        }),
      }),
    );

    expect(state.asset_class_tripped).toEqual({ crypto: true, stocks: false });
    expect(state.portfolio_tripped).toBe(false);
    expect(state.armed_breakers).toEqual([
      'daily_pnl_unknown:crypto (no crypto session-open equity observed)',
    ]);
  });

  it('halts ONE class on its own daily-loss breach, leaving the other tradeable (#333)', () => {
    const breakers = new CircuitBreakers(
      makeConfig({ daily_loss_pct: 3, daily_loss_pct_by_class: { crypto: 5, stocks: 5 } }),
    );

    // Crypto down 6% while stocks are up 4%. All three figures share one
    // denominator (portfolio equity), so the portfolio nets to −2% — inside its
    // own 3% floor. This is precisely the case surgical halting exists for: the
    // account-wide tier alone would let crypto keep bleeding.
    const state = breakers.evaluate(
      makeInput({
        portfolio: makePortfolio({
          daily_pnl: {
            crypto: { known: true, pct: -6 },
            stocks: { known: true, pct: 4 },
            portfolio: { known: true, pct: -2 },
          },
        }),
      }),
    );

    expect(state.asset_class_tripped).toEqual({ crypto: true, stocks: false });
    expect(state.portfolio_tripped).toBe(false);
    expect(state.armed_breakers).toEqual(['daily_loss_soft:crypto']);
  });

  it('keeps the account-wide floor: a portfolio breach halts everything regardless of class', () => {
    const breakers = new CircuitBreakers(
      makeConfig({ daily_loss_pct: 3, daily_loss_pct_by_class: { crypto: 5, stocks: 5 } }),
    );

    // Both classes inside their own 5% tier, portfolio through its 3% floor.
    // Surgical halting was ADDED, not swapped in — neither tier can be traded
    // away for the other.
    const state = breakers.evaluate(
      makeInput({
        portfolio: makePortfolio({
          daily_pnl: {
            crypto: { known: true, pct: -4 },
            stocks: { known: true, pct: -4 },
            portfolio: { known: true, pct: -4 },
          },
        }),
      }),
    );

    expect(state.portfolio_tripped).toBe(true);
    expect(state.asset_class_tripped).toEqual({ crypto: false, stocks: false });
    expect(state.armed_breakers).toEqual(['daily_loss_soft']);
  });

  it('recomputes the per-class tier every call — non-sticky, like the rest of the soft tier', () => {
    const breakers = new CircuitBreakers(
      makeConfig({ daily_loss_pct: 3, daily_loss_pct_by_class: { crypto: 5, stocks: 5 } }),
    );
    const breached = makePortfolio({
      daily_pnl: {
        crypto: { known: true, pct: -6 },
        stocks: { known: true, pct: 0 },
        portfolio: { known: true, pct: -3 },
      },
    });

    expect(breakers.evaluate(makeInput({ portfolio: breached })).asset_class_tripped.crypto).toBe(
      true,
    );

    // Recovery, same instance: only the hard drawdown breaker is sticky, so a
    // class that comes back inside its threshold trades again with no reArm().
    expect(breakers.evaluate(makeInput()).asset_class_tripped.crypto).toBe(false);
  });

  it('joins the volatility halt rather than replacing it — either source halts the class', () => {
    const breakers = new CircuitBreakers(
      makeConfig({ daily_loss_pct: 3, daily_loss_pct_by_class: { crypto: 5, stocks: 5 } }),
    );

    // Crypto through its daily-loss tier; stocks through the volatility tier.
    // Both land in the same `asset_class_tripped` field from different causes,
    // and the armed list has to keep them distinguishable for the operator.
    const state = breakers.evaluate(
      makeInput({
        volatility: { crypto: 1, stocks: 5 },
        portfolio: makePortfolio({
          daily_pnl: {
            crypto: { known: true, pct: -6 },
            stocks: { known: true, pct: 0 },
            portfolio: { known: true, pct: -2 },
          },
        }),
      }),
    );

    expect(state.asset_class_tripped).toEqual({ crypto: true, stocks: true });
    expect(state.portfolio_tripped).toBe(false);
    expect(state.armed_breakers).toEqual(['daily_loss_soft:crypto', 'volatility_halt:stocks']);
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
