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
  /**
   * Soft, portfolio-level: cumulative daily PnL below -this% halts new entries
   * ACCOUNT-WIDE. Measured over the portfolio UTC day (#332, decision 3) — the
   * account-wide floor, kept alongside the per-class tier below rather than
   * replaced by it, so surgical halting is added and not traded for.
   */
  daily_loss_pct: number;
  /**
   * Soft, per-class: that class's daily PnL below -this% halts NEW ENTRIES IN
   * THAT CLASS ONLY, joining `volatility_halt:<class>` in `asset_class_tripped`
   * (#333, decision 4).
   *
   * Each figure is measured over its OWN session, and the two sessions are
   * different: `crypto` from 00:00 UTC, `stocks` from the previous 16:00 ET
   * close. That is why these thresholds are named by class rather than shared —
   * a reader comparing against `crypto` here is comparing over a UTC day, and
   * against `stocks` over a US equity session, without opening the spec.
   *
   * The DENOMINATOR, though, is portfolio equity for all three figures, so this
   * threshold and `daily_loss_pct` sit on one scale and neither needs re-tuning
   * against the other. Values themselves are paper-trading tuning and out of
   * scope here (risk-manager-spec.md, "Out of Scope: Exact limit values").
   */
  daily_loss_pct_by_class: { crypto: number; stocks: number };
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
    // Unknown BLOCKS, as of #333 — it no longer arms an advisory marker only.
    // Decision 5: a daily figure nobody has must stop new entries rather than
    // read as a flat day. Safe to halt on because it is non-sticky like the
    // rest of this tier: it clears the moment the figure is known again, at the
    // next session boundary this process is up for. That is the "path back"
    // whose absence is why #332 left this advisory.
    //
    // NOT mode-gated here, deliberately, even though decision 5 is a mode-gated
    // decision. There are two upstream paths to `known: false` and only one of
    // them is about mode:
    //
    // - `AccountStateProvider.midSessionBase` IS mode-gated — `paper`/`backtest`
    //   report against a mid-session base and warn; only `live` reports unknown.
    //   That is decision 5's cold-start gate, and it already lives there.
    // - `AccountStateProvider.nonPositiveBase` is NOT, in any mode: a percentage
    //   against a zero or negative session-open equity has no meaning to gate.
    //
    // So a `paper` run CAN present an unknown, and this breaker must halt on it
    // rather than assume the mode already filtered it out. Re-testing `mode`
    // here would both gate the cold-start decision twice and hand the
    // non-positive-base case a silent pass in exactly the mode where the
    // account has none of itself left.
    const dailyUnknown = !dailyPnl.known;
    if (dailyUnknown) {
      armed.push(`daily_pnl_unknown:portfolio (${dailyPnl.reason})`);
    }

    // The per-class tier (#333, decision 4). Each class is judged over its own
    // session against its own threshold, and a breach halts THAT CLASS ONLY —
    // crypto can stop while stocks keep trading. Same narrowing discipline and
    // same unknown-blocks rule as the portfolio figure above.
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
      this.hardTripped ||
      this.killSwitchEngaged ||
      dailyLossTripped ||
      dailyUnknown ||
      consecutiveLossTripped;

    return {
      portfolio_tripped: portfolioTripped,
      asset_class_tripped: {
        crypto: cryptoVolTripped || classTripped.crypto,
        stocks: stocksVolTripped || classTripped.stocks,
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
