import type { Clock } from '../../shared/index.js';
import { assertThresholdsWithinBounds } from '../../shared/index.js';
import type { BreakerState, PersistedBreakerState, PortfolioView } from './types.js';

interface VolatilityBreakerConfig {
  baseline: { crypto: number; stocks: number };
  multiplier: number;
}

interface AutoReArmPolicy {
  recovery_drawdown_pct: number;
  max_days_tripped: number;
}

export interface BreakerConfig {
  daily_loss_pct: number;
  daily_loss_pct_by_class: { crypto: number; stocks: number };
  max_drawdown_pct: number;
  max_consecutive_losses: number;
  volatility: VolatilityBreakerConfig;
  auto_rearm: AutoReArmPolicy;
}

export interface VolatilityReading {
  crypto: number;
  stocks: number;
}

export interface BreakerEvalInput {
  portfolio: PortfolioView;
  volatility: VolatilityReading;
  mode: 'live' | 'paper' | 'backtest';
  clock: Clock;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class CircuitBreakers {
  private hardTripped = false;
  private hardTrippedAt: Date | null = null;
  private killSwitchEngaged = false;
  private killSwitchReason: string | null = null;

  constructor(
    private readonly config: BreakerConfig,
    initial?: readonly PersistedBreakerState[],
  ) {
    assertThresholdsWithinBounds(
      {
        max_drawdown_pct: config.max_drawdown_pct,
        recovery_drawdown_pct: config.auto_rearm.recovery_drawdown_pct,
        daily_loss_pct: config.daily_loss_pct,
        daily_loss_pct_crypto: config.daily_loss_pct_by_class.crypto,
        daily_loss_pct_stocks: config.daily_loss_pct_by_class.stocks,
      },
      'CircuitBreakers',
    );
    if (!(config.auto_rearm.recovery_drawdown_pct < config.max_drawdown_pct)) {
      throw new Error(
        `BreakerConfig: auto_rearm.recovery_drawdown_pct ` +
          `(${config.auto_rearm.recovery_drawdown_pct}) must be strictly below ` +
          `max_drawdown_pct (${config.max_drawdown_pct}). The two are the edges of one ` +
          'hysteresis band — trip at the upper, re-arm below the lower — so a band of ' +
          'zero or negative width re-arms the hard drawdown breaker in the same evaluate() ' +
          'call that tripped it, silently halting nothing.',
      );
    }
    for (const row of initial ?? []) {
      if (row.tier === 'portfolio_drawdown') {
        this.hardTripped = row.tripped;
        this.hardTrippedAt = row.tripped_at;
      } else if (row.tier === 'kill_switch') {
        this.killSwitchEngaged = row.tripped;
        this.killSwitchReason = row.reason;
      }
    }
  }

  getPersistedState(): PersistedBreakerState[] {
    return [
      {
        tier: 'portfolio_drawdown',
        tripped: this.hardTripped,
        tripped_at: this.hardTrippedAt,
        reset_at: null,
        reason: this.hardTripped ? 'portfolio_drawdown_hard' : null,
      },
      {
        tier: 'kill_switch',
        tripped: this.killSwitchEngaged,
        tripped_at: null,
        reset_at: null,
        reason: this.killSwitchReason,
      },
    ];
  }

  reArm(): void {
    this.hardTripped = false;
    this.hardTrippedAt = null;
  }

  engageKillSwitch(reason: string): void {
    this.killSwitchEngaged = true;
    this.killSwitchReason = reason;
  }

  releaseKillSwitch(): void {
    this.killSwitchEngaged = false;
    this.killSwitchReason = null;
  }

  evaluate(input: BreakerEvalInput): BreakerState {
    const { portfolio, volatility, mode, clock } = input;
    const armed: string[] = [];

    armed.push(...this.evaluateHardDrawdownBreaker(portfolio, clock, mode));

    if (this.killSwitchEngaged) {
      armed.push(this.killSwitchReason ? `kill_switch:${this.killSwitchReason}` : 'kill_switch');
    }

    const dailyLoss = this.evaluateDailyLossBreakers(portfolio);
    armed.push(...dailyLoss.armed);

    const consecutiveLossTripped =
      portfolio.consecutive_losses >= this.config.max_consecutive_losses;
    if (consecutiveLossTripped) {
      armed.push('consecutive_loss_cooldown');
    }

    const vol = this.evaluateVolatilityBreakers(volatility);
    armed.push(...vol.armed);

    const portfolioTripped =
      this.hardTripped ||
      this.killSwitchEngaged ||
      dailyLoss.dailyLossTripped ||
      dailyLoss.dailyUnknown ||
      consecutiveLossTripped;

    return {
      portfolio_tripped: portfolioTripped,
      asset_class_tripped: {
        crypto: vol.cryptoVolTripped || dailyLoss.classTripped.crypto,
        stocks: vol.stocksVolTripped || dailyLoss.classTripped.stocks,
      },
      armed_breakers: armed,
    };
  }

  private evaluateHardDrawdownBreaker(
    portfolio: PortfolioView,
    clock: Clock,
    mode: BreakerEvalInput['mode'],
  ): string[] {
    if (!this.hardTripped && portfolio.drawdown_pct >= this.config.max_drawdown_pct) {
      this.hardTripped = true;
      this.hardTrippedAt = clock.now();
    }
    if (this.hardTripped) {
      this.maybeAutoReArm(portfolio, clock, mode);
    }
    return this.hardTripped ? ['portfolio_drawdown_hard'] : [];
  }

  private evaluateDailyLossBreakers(portfolio: PortfolioView): {
    dailyLossTripped: boolean;
    dailyUnknown: boolean;
    classTripped: { crypto: boolean; stocks: boolean };
    armed: string[];
  } {
    const armed: string[] = [];

    const dailyPnl = portfolio.daily_pnl.portfolio;
    const dailyLossTripped = dailyPnl.known && dailyPnl.pct <= -this.config.daily_loss_pct;
    if (dailyLossTripped) {
      armed.push('daily_loss_soft');
    }
    const dailyUnknown = !dailyPnl.known;
    if (dailyUnknown) {
      armed.push(`daily_pnl_unknown:portfolio (${dailyPnl.reason})`);
    }

    const classTripped = { crypto: false, stocks: false };
    for (const asset_class of ['crypto', 'stocks'] as const) {
      const pnl = portfolio.daily_pnl[asset_class];
      if (!pnl.known) {
        classTripped[asset_class] = true;
        armed.push(`daily_pnl_unknown:${asset_class} (${pnl.reason})`);
        continue;
      }
      if (pnl.pct <= -this.config.daily_loss_pct_by_class[asset_class]) {
        classTripped[asset_class] = true;
        armed.push(`daily_loss_soft:${asset_class}`);
      }
    }

    return { dailyLossTripped, dailyUnknown, classTripped, armed };
  }

  private evaluateVolatilityBreakers(volatility: BreakerEvalInput['volatility']): {
    cryptoVolTripped: boolean;
    stocksVolTripped: boolean;
    armed: string[];
  } {
    const armed: string[] = [];

    const cryptoVolTripped =
      volatility.crypto >
      this.config.volatility.baseline.crypto * this.config.volatility.multiplier;
    if (cryptoVolTripped) {
      armed.push('volatility_halt:crypto');
    }

    const stocksVolTripped =
      volatility.stocks >
      this.config.volatility.baseline.stocks * this.config.volatility.multiplier;
    if (stocksVolTripped) {
      armed.push('volatility_halt:stocks');
    }

    return { cryptoVolTripped, stocksVolTripped, armed };
  }

  private maybeAutoReArm(
    portfolio: PortfolioView,
    clock: Clock,
    mode: BreakerEvalInput['mode'],
  ): void {
    const recovered = portfolio.drawdown_pct < this.config.auto_rearm.recovery_drawdown_pct;
    const daysTripped = this.hardTrippedAt
      ? (clock.now().getTime() - this.hardTrippedAt.getTime()) / MS_PER_DAY
      : 0;
    const timedOut = mode === 'backtest' && daysTripped >= this.config.auto_rearm.max_days_tripped;
    if (recovered || timedOut) {
      this.hardTripped = false;
      this.hardTrippedAt = null;
    }
  }
}
