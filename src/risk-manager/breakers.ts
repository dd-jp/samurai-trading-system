/**
 * Circuit breaker computation for the Risk Manager (Stage 4) — ticket #77.
 * See docs/specs/risk-manager-spec.md ("Module: Circuit Breakers") and
 * docs/wayfinder/risk-manager-map.md ("Breaker thresholds & definitions").
 *
 * Produces the `BreakerState` the check pipeline (#76, src/risk-manager/index.ts)
 * consumes as a pre-built input. `PortfolioView` only carries a single
 * portfolio-level `daily_pnl_pct` / `consecutive_losses` (no per-asset-class
 * breakdown — that shape is owned by #78), so those two breakers trip at the
 * portfolio tier. The volatility halt is the breaker that is genuinely
 * per-asset-class: it compares a caller-supplied current reading (from
 * MarketDataService.getIndicator, fetched by the caller since this stays a
 * synchronous, deterministic-given-inputs computation) against a configured
 * per-class baseline.
 */
import type { Clock } from '../shared/index.js';
import type { BreakerState, PersistedBreakerState, PortfolioView } from './types.js';

/** Config for the per-asset-class volatility halt. */
export interface VolatilityBreakerConfig {
  /** Baseline realized-vol reading per asset class, tuned in paper trading. */
  baseline: { crypto: number; stocks: number };
  /** Current reading trips the halt once it exceeds baseline * multiplier. */
  multiplier: number;
}

/** Backtest-only policy for re-arming the hard drawdown breaker without a manual call. */
export interface AutoReArmPolicy {
  /** Re-arm once drawdown_pct recovers back below this threshold. */
  recovery_drawdown_pct: number;
  /** Or after this many days have elapsed since trip, whichever comes first. */
  max_days_tripped: number;
}

/**
 * Static, config-driven breaker thresholds. Exact values are tuned in paper
 * trading (risk-manager-spec.md "Out of Scope: Exact limit values") — this
 * is the shape, not the numbers.
 */
export interface BreakerConfig {
  /** Soft, portfolio-level: cumulative daily PnL below -this% halts new entries. */
  daily_loss_pct: number;
  /** Hard, portfolio-level: peak-to-trough drawdown at/above this% halts new entries. */
  max_drawdown_pct: number;
  /** Soft, portfolio-level: N losing trades in a row halts new entries. */
  max_consecutive_losses: number;
  volatility: VolatilityBreakerConfig;
  /** Consulted only in 'backtest' mode; live and paper always require a manual reArm() call. */
  auto_rearm: AutoReArmPolicy;
}

/** Current realized-vol indicator reading per asset class, fetched by the caller. */
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

/**
 * Computes tiered circuit-breaker state. Four breakers (daily-loss,
 * consecutive-loss, volatility, and the soft half of the operational
 * kill-switch path) are stateless — derived fresh from the current
 * `PortfolioView`/reading each call, so they auto-reset the moment the
 * underlying metric recovers. The hard drawdown breaker and the kill-switch
 * are sticky: once tripped/engaged they stay that way across calls until
 * `reArm()` (live) / the configured auto-re-arm policy (backtest) /
 * `releaseKillSwitch()` clears them.
 *
 * Crash-restart safety (#203): the sticky fields above are the only state
 * a process restart must not silently lose — a tripped hard breaker that
 * re-arms itself on restart would defeat the reason it halted trading.
 * `getPersistedState()` exports them as lossless `PersistedBreakerState`
 * rows (one per tier) for the caller to write to the `breaker_state` table
 * after each `evaluate()`/`reArm()`/`engageKillSwitch()`/`releaseKillSwitch()`
 * call; passing those same rows back into the constructor on the next
 * startup reconstructs this instance exactly. `CircuitBreakers` itself never
 * touches a store — it only accepts/exposes plain data, so this stays
 * synchronous and DB-free (the actual SQLite wiring is later, gated on #193).
 */
export class CircuitBreakers {
  private hardTripped = false;
  private hardTrippedAt: Date | null = null;
  private killSwitchEngaged = false;
  private killSwitchReason: string | null = null;

  constructor(
    private readonly config: BreakerConfig,
    initial?: readonly PersistedBreakerState[],
  ) {
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

  /** Lossless snapshot of the sticky breakers, one row per tier — for the caller to persist. */
  getPersistedState(): PersistedBreakerState[] {
    return [
      {
        tier: 'portfolio_drawdown',
        tripped: this.hardTripped,
        tripped_at: this.hardTrippedAt,
        // Reset timing isn't tracked in-memory (reArm() only clears the trip); the
        // caller can derive it from its own clock at write time if it needs one.
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

  /** Manual re-arm of the hard peak-to-trough drawdown breaker (live/paper mode). */
  reArm(): void {
    this.hardTripped = false;
    this.hardTrippedAt = null;
  }

  /** Engages the operational kill-switch (manual or dead-man's trigger). Sticky until released. */
  engageKillSwitch(reason: string): void {
    this.killSwitchEngaged = true;
    this.killSwitchReason = reason;
  }

  /** Manual re-arm of the kill-switch. */
  releaseKillSwitch(): void {
    this.killSwitchEngaged = false;
    this.killSwitchReason = null;
  }

  evaluate(input: BreakerEvalInput): BreakerState {
    const { portfolio, volatility, mode, clock } = input;
    const armed: string[] = [];

    if (!this.hardTripped && portfolio.drawdown_pct >= this.config.max_drawdown_pct) {
      this.hardTripped = true;
      this.hardTrippedAt = clock.now();
    }
    if (this.hardTripped && mode === 'backtest') {
      this.maybeAutoReArm(portfolio, clock);
    }
    if (this.hardTripped) {
      armed.push('portfolio_drawdown_hard');
    }

    if (this.killSwitchEngaged) {
      armed.push(this.killSwitchReason ? `kill_switch:${this.killSwitchReason}` : 'kill_switch');
    }

    // Portfolio-level figure, UTC-bounded (#332). Narrowed explicitly rather
    // than compared directly: an unknown must never reach the threshold test,
    // where a coerced `0 <= -daily_loss_pct` would read a figure nobody has as
    // a flat day and leave this breaker un-tripped through a real loss.
    const dailyPnl = portfolio.daily_pnl.portfolio;
    const dailyLossTripped = dailyPnl.known && dailyPnl.pct <= -this.config.daily_loss_pct;
    if (dailyLossTripped) {
      armed.push('daily_loss_soft');
    }
    // Unknown is surfaced, not silently skipped — the #293/#320/#324/#342
    // posture: a degraded state must be visible in the audit trail and the
    // operator's breaker summary rather than reached quietly.
    //
    // It is NOT set as `portfolio_tripped` here. Turning "unknown" into a halt
    // is the two-tier daily-loss halting of #333, which owns that decision and
    // its re-arm semantics; arming a name this breaker cannot itself clear
    // would strand the system halted with no path back. So this arms an
    // advisory marker only, and #333 escalates it to a block on new entries.
    if (!dailyPnl.known) {
      armed.push('daily_pnl_unknown');
    }

    const consecutiveLossTripped =
      portfolio.consecutive_losses >= this.config.max_consecutive_losses;
    if (consecutiveLossTripped) {
      armed.push('consecutive_loss_cooldown');
    }

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

    const portfolioTripped =
      this.hardTripped || this.killSwitchEngaged || dailyLossTripped || consecutiveLossTripped;

    return {
      portfolio_tripped: portfolioTripped,
      asset_class_tripped: {
        crypto: cryptoVolTripped,
        stocks: stocksVolTripped,
      },
      armed_breakers: armed,
    };
  }

  private maybeAutoReArm(portfolio: PortfolioView, clock: Clock): void {
    const recovered = portfolio.drawdown_pct < this.config.auto_rearm.recovery_drawdown_pct;
    const daysTripped = this.hardTrippedAt
      ? (clock.now().getTime() - this.hardTrippedAt.getTime()) / MS_PER_DAY
      : 0;
    const timedOut = daysTripped >= this.config.auto_rearm.max_days_tripped;
    if (recovered || timedOut) {
      this.hardTripped = false;
      this.hardTrippedAt = null;
    }
  }
}
