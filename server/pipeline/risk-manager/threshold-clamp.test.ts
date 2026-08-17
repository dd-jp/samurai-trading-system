/**
 * #638 acceptance, Risk-Manager half: every guarded breaker threshold set past
 * its line, asserting the system REFUSES rather than runs with it.
 *
 * Two seams, and the second is the one that matters. The constructor check is
 * boot-time; `resolveRiskConfig` is the LIVE path — `RiskManagerImpl.evaluate()`
 * re-reads the `risk_thresholds` table on every call, so a value written
 * between two ticks binds on the second one without passing through startup
 * again. A boot-only clamp would constrain nothing the Feedback Loop does.
 */
import { ThresholdBoundViolationError } from '../../shared/index.js';
import type { BreakerConfig } from './breakers.js';
import { CircuitBreakers } from './breakers.js';
import { RISK_THRESHOLD_KEYS, resolveRiskConfig } from './risk-thresholds.js';
import type { RiskConfig } from './types.js';

function makeBreakerConfig(overrides: Partial<BreakerConfig> = {}): BreakerConfig {
  return {
    daily_loss_pct: 0.03,
    daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
    max_drawdown_pct: 0.2,
    max_consecutive_losses: 4,
    volatility: { baseline: { crypto: 2, stocks: 1 }, multiplier: 2 },
    auto_rearm: { recovery_drawdown_pct: 0.1, max_days_tripped: 5 },
    ...overrides,
  };
}

function makeRiskConfig(): RiskConfig {
  return {
    max_position_size: 5_000,
    per_asset_cap: 10_000,
    per_asset_class_cap: { crypto: 20_000, stocks: 40_000 },
    portfolio_gross_cap: 50_000,
    concentration: { cap: 20_000, threshold: 0.7 },
    min_viable_size: 100,
    cii_threshold: 70,
    max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
  };
}

describe('CircuitBreakers — in-code threshold clamp at construction (#638)', () => {
  it('boots on the shipped paper values — the clamp bounds the dial, it does not forbid one', () => {
    expect(() => new CircuitBreakers(makeBreakerConfig())).not.toThrow();
  });

  it('refuses to construct when max_drawdown_pct is past its ceiling', () => {
    expect(() => new CircuitBreakers(makeBreakerConfig({ max_drawdown_pct: 0.9 }))).toThrow(
      ThresholdBoundViolationError,
    );
  });

  it('refuses the 0.95/0.90 pair the relative width check accepts', () => {
    // The pre-existing guard is an ORDERING test only: 0.90 is strictly below
    // 0.95, so it passes, and leaves a drawdown breaker that never fires. This
    // is the exact hole the absolute clamp exists to close.
    expect(
      () =>
        new CircuitBreakers(
          makeBreakerConfig({
            max_drawdown_pct: 0.95,
            auto_rearm: { recovery_drawdown_pct: 0.9, max_days_tripped: 5 },
          }),
        ),
      // Both edges are out, and both are named — an operator fixing only the
      // one the error happened to mention first would boot straight into the
      // second refusal.
    ).toThrow(/max_drawdown_pct[\s\S]*recovery_drawdown_pct/);
  });

  it('refuses to construct when recovery_drawdown_pct is past its ceiling', () => {
    expect(
      () =>
        new CircuitBreakers(
          makeBreakerConfig({
            max_drawdown_pct: 0.35,
            auto_rearm: { recovery_drawdown_pct: 0.3, max_days_tripped: 5 },
          }),
        ),
    ).toThrow(/recovery_drawdown_pct/);
  });

  it('refuses to construct when the portfolio daily-loss tier is past its ceiling', () => {
    expect(() => new CircuitBreakers(makeBreakerConfig({ daily_loss_pct: 0.5 }))).toThrow(
      /daily_loss_pct/,
    );
  });

  it('refuses to construct when either per-class daily-loss tier is past its ceiling', () => {
    expect(
      () =>
        new CircuitBreakers(
          makeBreakerConfig({ daily_loss_pct_by_class: { crypto: 0.5, stocks: 0.05 } }),
        ),
    ).toThrow(/daily_loss_pct_crypto/);

    expect(
      () =>
        new CircuitBreakers(
          makeBreakerConfig({ daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.5 } }),
        ),
    ).toThrow(/daily_loss_pct_stocks/);
  });
});

describe('resolveRiskConfig — the LIVE read path (#638)', () => {
  it('resolves normally when every stored row is in bounds', () => {
    expect(() =>
      resolveRiskConfig(makeRiskConfig(), { max_position_size: 1_000, max_drawdown_pct: 0.3 }),
    ).not.toThrow();
  });

  it('refuses a stored breaker row past its line, even though it is never applied', () => {
    // `max_drawdown_pct` is deliberately NOT in `RISK_THRESHOLD_KEYS`, so this
    // row changes no cap. It still stops the process: a stored value that
    // crosses a bright line means something in the system tried to cross it,
    // and ignoring the row would leave that silent.
    expect(RISK_THRESHOLD_KEYS).not.toContain('max_drawdown_pct');

    expect(() => resolveRiskConfig(makeRiskConfig(), { max_drawdown_pct: 0.95 })).toThrow(
      ThresholdBoundViolationError,
    );
  });

  it('refuses a stored kill-line row past its line', () => {
    expect(() => resolveRiskConfig(makeRiskConfig(), { max_pbo: 0.5 })).toThrow(
      ThresholdBoundViolationError,
    );
  });

  it('names the live table in the refusal, so the boot path is not blamed for it', () => {
    expect(() => resolveRiskConfig(makeRiskConfig(), { daily_loss_pct: 0.4 })).toThrow(
      /risk_thresholds table/,
    );
  });

  it('leaves the six tunable caps unguarded — they carry no research bright line', () => {
    // Guarding a notional cap would be inventing a limit no document states,
    // and would freeze the Feedback Loop's only working dials.
    expect(() =>
      resolveRiskConfig(makeRiskConfig(), {
        max_position_size: 10 ** 9,
        per_asset_cap: 10 ** 9,
        per_asset_class_cap_crypto: 10 ** 9,
        per_asset_class_cap_stocks: 10 ** 9,
        portfolio_gross_cap: 10 ** 9,
        concentration_cap: 10 ** 9,
      }),
    ).not.toThrow();
  });
});
