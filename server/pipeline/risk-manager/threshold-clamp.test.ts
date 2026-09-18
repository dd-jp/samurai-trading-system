import type { Clock } from '../../shared/index.js';
import { GUARDED_THRESHOLD_BOUNDS, ThresholdBoundViolationError } from '../../shared/index.js';
import type { BreakerConfig, BreakerEvalInput } from './breakers.js';
import { CircuitBreakers } from './breakers.js';
import { RISK_THRESHOLD_KEYS, resolveRiskConfig } from './risk-thresholds.js';
import type { DailyPnlByClass, PortfolioView, RiskConfig } from './types.js';

function pnl(pct: number): DailyPnlByClass {
  const known = { known: true, pct } as const;
  return { crypto: known, stocks: known, portfolio: known };
}

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
    max_position_size_fraction_of_equity: 5_000,
    per_asset_cap_fraction_of_equity: 10_000,
    per_asset_class_cap_fraction_of_equity: { crypto: 20_000, stocks: 40_000 },
    portfolio_gross_cap_fraction_of_equity: 50_000,
    concentration: { cap_fraction_of_equity: 20_000, threshold: 0.7 },
    min_viable_size: 100,
    whole_share_sizing: false,
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
    expect(
      () =>
        new CircuitBreakers(
          makeBreakerConfig({
            max_drawdown_pct: 0.95,
            auto_rearm: { recovery_drawdown_pct: 0.9, max_days_tripped: 5 },
          }),
        ),
    ).toThrow(/max_drawdown_pct[\s\S]*recovery_drawdown_pct/);
  });

  it('refuses to construct when recovery_drawdown_pct is past its ceiling', () => {
    expect(
      () =>
        new CircuitBreakers(
          makeBreakerConfig({
            max_drawdown_pct: 0.44,
            auto_rearm: { recovery_drawdown_pct: 0.42, max_days_tripped: 5 },
          }),
        ),
    ).toThrow(/recovery_drawdown_pct/);
  });

  it(
    'keeps the recovery_drawdown_pct ceiling strictly below the max_drawdown_pct ' +
      'ceiling (#925) — the structural bug this issue fixed was the ceiling ' +
      'drifting below the accepted envelope',
    () => {
      expect(GUARDED_THRESHOLD_BOUNDS.recovery_drawdown_pct.max).toBeLessThan(
        GUARDED_THRESHOLD_BOUNDS.max_drawdown_pct.max as number,
      );
      expect(GUARDED_THRESHOLD_BOUNDS.max_drawdown_pct.max as number).toBeGreaterThan(0.418);
    },
  );

  it(
    'cannot fire on a single-stock position at its accepted 41.8% envelope (#729/#798), ' +
      'the same discipline this file already applies to the ceiling itself (#925)',
    () => {
      const breakers = new CircuitBreakers(
        makeBreakerConfig({
          max_drawdown_pct: 0.44,
          auto_rearm: { recovery_drawdown_pct: 0.2, max_days_tripped: 5 },
        }),
      );
      const portfolio: PortfolioView = {
        equity: 58_200,
        peak_equity: 100_000,
        drawdown_pct: 0.418,
        exposure_by_instrument: {},
        exposure_by_class: { crypto: 0, stocks: 0 },
        gross_exposure: 0,
        reserved_exposure_by_instrument: {},
        reserved_exposure_by_class: { crypto: 0, stocks: 0 },
        reserved_gross_exposure: 0,
        daily_pnl: pnl(0),
        consecutive_losses: 0,
        unvalued_instruments: [],
      };
      const clock: Clock = { now: () => new Date('2026-08-31T09:30:00Z') };
      const input: BreakerEvalInput = {
        portfolio,
        volatility: { crypto: 1, stocks: 0.5 },
        mode: 'live',
        clock,
      };

      const state = breakers.evaluate(input);

      expect(state.armed_breakers).not.toContain('portfolio_drawdown_hard');
    },
  );

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
      resolveRiskConfig(makeRiskConfig(), {
        max_position_size_fraction_of_equity: 1_000,
        max_drawdown_pct: 0.3,
      }),
    ).not.toThrow();
  });

  it('refuses a stored breaker row past its line, even though it is never applied', () => {
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
    expect(() =>
      resolveRiskConfig(makeRiskConfig(), {
        max_position_size_fraction_of_equity: 10 ** 9,
        per_asset_cap_fraction_of_equity: 10 ** 9,
        per_asset_class_cap_fraction_of_equity_crypto: 10 ** 9,
        per_asset_class_cap_fraction_of_equity_stocks: 10 ** 9,
        portfolio_gross_cap_fraction_of_equity: 10 ** 9,
        concentration_cap_fraction_of_equity: 10 ** 9,
      }),
    ).not.toThrow();
  });
});
