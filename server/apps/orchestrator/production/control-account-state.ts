/**
 * Falsifier arm 2's own account state (#753) — the control arm's `cash`,
 * `peak_equity`, `daily_basis` and `consecutive_losses`, derived from the
 * control arm's OWN book and from nothing else.
 *
 * ## Why this exists at all
 *
 * `control-arm-wiring.ts` gives the control arm its own `SqliteExecutionStore`
 * (`arm: 'control'`), its own `SimulatedBrokerAdapter`, its own
 * `CircuitBreakers` instance and its own breaker-state home. All four are there
 * so the two arms cannot move each other. But `computeCurrentPortfolioAndBreakers`
 * (direct-bind.ts) combines those control-scoped positions with
 * `deps.accountState.getAccountState(asOf)`, and until this module existed the
 * only `AccountStateProvider` in the tree was `AlpacaAccountStateProvider` —
 * ONE instance, constructed in `production.ts`, reading `GET /v2/account`.
 *
 * The control arm never touches the real broker, so that account reflects the
 * LIVE arm's trades exclusively. Sharing it made the control's D5 position
 * sizing (a fraction of `portfolio.equity`) and its drawdown-halt timing (a
 * function of `peak_equity`) a function of the live arm's realized cash — a
 * control that is not an independent measurement over the same tape, which is
 * the one thing #753 exists to produce. The `arm = 'live'` filters on
 * `realizedSince`/`realizedSinceAllClasses` bound the contamination to
 * live -> control; they do not remove it.
 *
 * ## What it derives, and from what
 *
 * The control's venue is simulated, so there is no ledger to read: the book IS
 * its own trade record. Every figure below therefore comes from two
 * arm-scoped reads — its `closed_trades` rows and its open lots — plus the
 * DECLARED book (`LIVE_BOOK_GBP`) as the starting cash. That mirrors the
 * `arm = 'live'` scoping already applied one layer down rather than inventing a
 * second mechanism, and it means a control-arm figure can never be moved by a
 * live-arm fill.
 *
 * | Field | Derivation |
 * |---|---|
 * | `cash` | declared book + realized PnL to date − cash deployed in open long lots |
 * | `peak_equity` | running max of (book + realized), floored at the book |
 * | `daily_basis` | (book + realized before the session open) as the denominator, realized since it as the numerator |
 * | `consecutive_losses` | the control's own closed trades, walked backwards |
 *
 * ## Three deliberate divergences from `AlpacaAccountStateProvider`
 *
 * 1. **`peak_equity` is a REALIZED high-water mark, not a marked one.** The
 *    live provider reads Alpaca's mark-to-market `equity` and stores its max,
 *    so an unrealized high raises the live peak. This one cannot: a provider
 *    is called before `computePortfolioView` fetches marks, and re-fetching
 *    them here would be a second valuation of the same book on the same tick
 *    (the thing #332 refused). The consequence is named rather than hidden: a
 *    control drawdown measured from a realized peak is never DEEPER than one
 *    measured from a marked peak, so the control's drawdown breaker is, if
 *    anything, slower than the live arm's. It errs towards letting the control
 *    keep trading, which biases against the control arm looking good on
 *    drawdown — the safe direction for a falsifier.
 * 2. **`daily_basis` is always `known`.** The live provider reports unknown in
 *    `live` mode when no equity was observed at the session boundary, because
 *    its opening figure is a SAMPLE that cannot be reconstructed. This one has
 *    no such problem — the opening figure is derived from an immutable trade
 *    record, so a restart mid-session re-derives exactly the same number. The
 *    matched-refusals property (`control-arm-wiring.ts`) is therefore weakened
 *    in one narrow case: a live arm halted by `daily_pnl_unknown` after a
 *    mid-session restart has a control arm that keeps trading. That is
 *    accepted, and it is the honest reading — the control's basis really is
 *    known — but it is a divergence, so it is recorded here rather than
 *    discovered later in the comparison.
 * 3. **Currency.** The book is GBP and the simulated fills are priced in the
 *    instrument's own currency, exactly the mismatch `RiskConfig.live_book_ceiling`
 *    documents for the live arm (which compares a GBP book against a USD
 *    Alpaca equity). No FX provider exists in this codebase; the arm
 *    comparison already divides both arms by `LIVE_BOOK_GBP` for the same
 *    reason. Nothing here makes that worse, and it is not this ticket's to fix.
 */
import type { SessionBasis, SessionBasisByClass } from '../../../pipeline/risk-manager/index.js';
import type { TradingCalendar } from '../../../providers/market-data-service/index.js';
import type { ClosedTrade, OpenPosition } from '../../../shared/index.js';
import type { SessionEquityKey } from '../sqlite-session-equity-store.js';
import type { ClosedTradeReader } from './account-state.js';
import type { AccountStateProvider } from './direct-bind.js';

const DEFAULT_LOSS_STREAK_WINDOW_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * The floor of the "all of it" window. The control arm's book starts empty, so
 * every row this reader can return belongs to this process's own measurement —
 * there is no pre-existing history to exclude.
 */
const EPOCH = new Date(0);

export interface ControlArmAccountStateProviderInput {
  /**
   * The declared book the control arm's own account starts at — `LIVE_BOOK_GBP`,
   * the same figure the live arm's D5 fractions and `live_book_ceiling` are
   * stated against. Passed in rather than imported so a test can state its own
   * anchor without restating the whole profile.
   */
  book: number;
  /**
   * The CONTROL arm's closed trades — a `SqliteClosedTradeStore` constructed
   * with `arm: 'control'`. Handing this the default (live) instance would
   * re-create the exact coupling this module exists to remove, so the arm is a
   * constructor argument at the composition root and not a filter here.
   */
  closedTrades: ClosedTradeReader;
  /** The control arm's open lots — the same arm-scoped store the breaker deps read. */
  getOpenPositions: () => Promise<readonly OpenPosition[]>;
  /**
   * The SAME two calendars the live provider is given. Shared on purpose: the
   * two arms must measure a "day" over identical boundaries or their daily
   * figures are not comparable.
   */
  calendars: { crypto: TradingCalendar; stocks: TradingCalendar };
  /** As `AlpacaAccountStateProviderInput.lossStreakWindowDays`. Default 365 days. */
  lossStreakWindowDays?: number;
}

export class ControlArmAccountStateProvider implements AccountStateProvider {
  /**
   * The realized high-water mark, held in memory for the same reason
   * `InMemoryBreakerStatePersistence` is: it is re-derivable from the trade
   * record on the next tick after a restart (max of the cumulative realized
   * curve), and no real money depends on it surviving one.
   */
  #peakEquity: number;

  constructor(private readonly input: ControlArmAccountStateProviderInput) {
    this.#peakEquity = input.book;
  }

  async getAccountState(asOf: Date): Promise<{
    cash: number;
    peak_equity: number;
    daily_basis: SessionBasisByClass;
    consecutive_losses: number;
  }> {
    // One read, reused by all four figures — the live provider's own posture
    // (`realizedFor` and `consecutiveLosses` both read the same store) without
    // its four separate round trips.
    const trades = this.input.closedTrades.getClosedTradesBetween(EPOCH, asOf);
    const positions = await this.input.getOpenPositions();

    const realized = trades.reduce((total, trade) => total + trade.realized_pnl_net, 0);
    const equityAtCost = this.input.book + realized;
    // Raised before it is read, exactly as `SqliteAccountStateStore.recordEquity`
    // does, so a new high shows up on the tick that set it.
    this.#peakEquity = Math.max(this.#peakEquity, equityAtCost);

    return {
      cash: equityAtCost - deployedCash(positions),
      peak_equity: this.#peakEquity,
      daily_basis: {
        crypto: this.sessionBasisFor('crypto', trades, asOf),
        stocks: this.sessionBasisFor('stocks', trades, asOf),
        portfolio: this.sessionBasisFor('portfolio', trades, asOf),
      },
      consecutive_losses: this.consecutiveLosses(trades, asOf),
    };
  }

  /** Same split the live provider makes: `portfolio` rides the crypto (UTC) boundary. */
  private calendarFor(key: SessionEquityKey): TradingCalendar {
    return key === 'stocks' ? this.input.calendars.stocks : this.input.calendars.crypto;
  }

  /**
   * The session basis, derived rather than sampled.
   *
   * `open_equity` sums EVERY class's realized PnL before the boundary, because
   * it is an account-level figure — the same thing the live provider reports
   * (one blended broker equity) for all three keys. Only the numerator is
   * class-filtered, which is what `realizedSince(class, openAt)` does live.
   */
  private sessionBasisFor(
    key: SessionEquityKey,
    trades: readonly ClosedTrade[],
    asOf: Date,
  ): SessionBasis {
    const sessionStart = this.calendarFor(key).sessionStart(asOf).getTime();

    let realizedBefore = 0;
    let realizedSince = 0;
    for (const trade of trades) {
      if (trade.closed_at.getTime() > sessionStart) {
        // Half-open at the start, matching `realizedSince`'s `closed_at > ?`,
        // so consecutive sessions partition the timeline exactly once.
        if (key === 'portfolio' || trade.asset_class === key) {
          realizedSince += trade.realized_pnl_net;
        }
      } else {
        realizedBefore += trade.realized_pnl_net;
      }
    }

    const openEquity = this.input.book + realizedBefore;
    // The live provider's guard, for the live provider's reason: a non-positive
    // denominator makes the fraction Infinity or NaN, and both compare false
    // against the breaker's threshold — a wiped-out account would read as "no
    // loss" rather than as a halt.
    if (!(openEquity > 0)) {
      return {
        known: false,
        reason:
          `daily PnL for the control arm's '${key}' is unknown: session-open equity was ` +
          `${openEquity}, and a percentage change against a non-positive base has no meaning`,
      };
    }

    return { known: true, open_equity: openEquity, realized_pnl: realizedSince };
  }

  /** As `AlpacaAccountStateProvider.consecutiveLosses`, over the control's own rows. */
  private consecutiveLosses(trades: readonly ClosedTrade[], asOf: Date): number {
    const windowDays = this.input.lossStreakWindowDays ?? DEFAULT_LOSS_STREAK_WINDOW_DAYS;
    const from = asOf.getTime() - windowDays * MS_PER_DAY;

    let streak = 0;
    for (let i = trades.length - 1; i >= 0; i -= 1) {
      const trade = trades[i];
      if (trade === undefined || trade.closed_at.getTime() <= from) break;
      if (trade.realized_pnl_net >= 0) break;
      streak += 1;
    }
    return streak;
  }
}

/**
 * Cash committed to open lots, at cost.
 *
 * LONG lots only. A short lot releases cash at a real venue and posts margin
 * instead, and modelling that would be inventing a margin ledger the simulated
 * adapter does not have; treating a short as committing no cash is the
 * conservative reading (it never overstates available cash). ADR-0018's
 * universe is long leveraged ETPs, so this branch is a guard rather than a
 * behaviour anyone trades through today.
 *
 * Entry FEES on still-open lots are not netted here — they land in
 * `realized_pnl_net` when the lot closes. The omission is bounded by one round
 * trip's costs on the open book and is deliberate: `fills` carries the
 * authoritative fee ledger, and reading it here would be a third accounting of
 * the same trade.
 */
function deployedCash(positions: readonly OpenPosition[]): number {
  return positions.reduce(
    (total, position) =>
      position.side === 'buy' ? total + position.avg_entry_price * position.filled_size : total,
    0,
  );
}
