import { describe, expect, it } from 'vitest';
import type { Clock } from '../shared/clock.js';
import type { BreakerConfig, BreakerEvalInput } from './breakers.js';
import { CircuitBreakers } from './breakers.js';
import type { PortfolioView } from './types.js';

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
    daily_pnl_pct: 0,
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
      makeInput({ portfolio: makePortfolio({ daily_pnl_pct: -2 }) }),
    );
    expect(belowThreshold.portfolio_tripped).toBe(false);

    const atThreshold = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ daily_pnl_pct: -3.5 }) }),
    );
    expect(atThreshold.portfolio_tripped).toBe(true);
    expect(atThreshold.armed_breakers).toContain('daily_loss_soft');
  });

  it('auto-resets the daily-loss breaker once daily_pnl_pct recovers (soft, stateless)', () => {
    const breakers = new CircuitBreakers(makeConfig({ daily_loss_pct: 3 }));
    breakers.evaluate(makeInput({ portfolio: makePortfolio({ daily_pnl_pct: -5 }) }));

    const recovered = breakers.evaluate(
      makeInput({ portfolio: makePortfolio({ daily_pnl_pct: 0 }) }),
    );
    expect(recovered.portfolio_tripped).toBe(false);
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
