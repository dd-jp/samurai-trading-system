/**
 * Falsifier arm 2's own account state — the control arm's `cash`,
 * `peak_equity`, `daily_basis` and `consecutive_losses`, derived from the
 * control arm's own book and nothing else.
 *
 * Without this, the only `AccountStateProvider` in the tree read the real
 * broker account, which reflects the live arm's trades exclusively — making
 * the control arm's sizing and drawdown-halt timing a function of the live
 * arm's realized cash, not an independent measurement over the same tape.
 *
 * The control's venue is simulated, so there is no ledger to read: every
 * figure below comes from the control arm's own `closed_trades` rows and
 * open lots, plus a starting book anchor resolved once (`resolveBook`).
 *
 * | Field | Derivation |
 * |---|---|
 * | `cash` | anchor + realized PnL to date − cash deployed in open long lots |
 * | `peak_equity` | running max of the cumulative realized curve (anchor + realized-to-date at each close, in trade order), floored at the anchor |
 * | `daily_basis` | (anchor + realized before the session open) as the denominator, realized since it as the numerator |
 * | `consecutive_losses` | the control's own closed trades, walked backwards |
 *
 * Four deliberate divergences from `BrokerAccountStateProvider`:
 *
 * 1. **`peak_equity` is a realized high-water mark, not a marked one** — a
 *    provider runs before marks are fetched, so re-fetching them here would
 *    double-value the same book. This makes the control's drawdown breaker
 *    slower than the live arm's, never faster — the safe direction for a
 *    falsifier.
 * 2. **`daily_basis` is always `known`** — its opening figure is derived
 *    from an immutable trade record, not sampled, so a restart mid-session
 *    re-derives the same number. This narrowly weakens the matched-refusals
 *    property: a live arm halted by `daily_pnl_unknown` after a mid-session
 *    restart has a control that keeps trading.
 * 3. **Currency** — the book is GBP and simulated fills price in the
 *    instrument's own currency, the same mismatch `RiskConfig.live_book_ceiling`
 *    documents for the live arm. Both arms share this denominator, so it
 *    moves neither against the other.
 * 4. **The starting book is the live arm's equity at first boot, not the
 *    declared £1,000** — a matched control must start at the same capital as
 *    the arm it's matched against. Since #1112 both arms clamp Trader-ask
 *    sizing to the same declared `capitalCeilingUsd`, so this anchor only
 *    needs to stay above that ceiling. Read once and persisted
 *    first-write-wins, so it's a single boot-time observation, not an
 *    ongoing coupling.
 */
import type {
  RiskConfig,
  SessionBasis,
  SessionBasisByClass,
} from '../../../pipeline/risk-manager/index.js';
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
   * The book the control arm's own account starts at, resolved once — on
   * the first `getAccountState` — and never consulted again.
   *
   * A resolver rather than a constant because the anchor must be the live
   * arm's starting equity, which isn't known at construction. Before #1112
   * a fixed anchor caused every control intent to round to zero shares
   * (live arm sized off ~$100k equity, control off £1,000 alone) — a
   * control that never trades is indistinguishable from one that never
   * found a setup. Since #1112, both arms clamp to the same
   * `capitalCeilingUsd`, so this anchor only needs to stay above that
   * shared ceiling.
   *
   * Resolved once and persisted first-write-wins (`CONTROL_BOOK_ANCHOR_KEY`)
   * so a restart re-reads the original anchor rather than re-anchoring to
   * the live arm's by-then-different equity, which would let the control's
   * book slowly track the live arm's performance across a multi-restart
   * soak.
   */
  resolveBook: (asOf: Date) => Promise<number>;
  /**
   * The CONTROL arm's closed trades — a `SqliteClosedTradeStore` constructed
   * with `arm: 'control'`. Handing this the default (live) instance would
   * re-create the exact coupling this module exists to remove, so the arm is a
   * constructor argument at the composition root and not a filter here.
   */
  closedTrades: ClosedTradeReader;
  /** The control arm's open lots — the same arm-scoped store the breaker deps read */
  getOpenPositions: () => Promise<readonly OpenPosition[]>;
  /**
   * The SAME two calendars the live provider is given. Shared on purpose: the
   * two arms must measure a "day" over identical boundaries or their daily
   * figures are not comparable.
   */
  calendars: { crypto: TradingCalendar; stocks: TradingCalendar };
  /** As `BrokerAccountStateProviderInput.lossStreakWindowDays`. Default 365 days. */
  lossStreakWindowDays?: number;
}

export class ControlArmAccountStateProvider implements AccountStateProvider {
  /** The resolved anchor. Null until the first `getAccountState`; set once. */
  #book: number | null = null;

  constructor(private readonly input: ControlArmAccountStateProviderInput) {}

  /**
   * The anchor, resolved on first use and cached for the life of the process.
   *
   * Cached on the instance, not re-read: a live-arm figure must be read
   * once, at boot, and never again on a decision path.
   */
  private async book(asOf: Date): Promise<number> {
    if (this.#book === null) {
      this.#book = await this.input.resolveBook(asOf);
    }
    return this.#book;
  }

  async getAccountState(asOf: Date): Promise<{
    cash: number;
    peak_equity: number;
    daily_basis: SessionBasisByClass;
    consecutive_losses: number;
  }> {
    // One read, reused by all four figures, rather than four separate round trips
    const book = await this.book(asOf);
    const trades = this.input.closedTrades.getClosedTradesBetween(EPOCH, asOf);
    const positions = await this.input.getOpenPositions();

    const realized = trades.reduce((total, trade) => total + trade.realized_pnl_net, 0);
    const equityAtCost = book + realized;

    return {
      cash: equityAtCost - deployedCash(positions),
      // Derived fresh from the full ordered trade curve on every cold read,
      // not carried in a running field a restart would reset to the anchor.
      peak_equity: realizedHighWaterMark(trades, book),
      daily_basis: {
        crypto: this.sessionBasisFor('crypto', trades, asOf, book),
        stocks: this.sessionBasisFor('stocks', trades, asOf, book),
        portfolio: this.sessionBasisFor('portfolio', trades, asOf, book),
      },
      consecutive_losses: this.consecutiveLosses(trades, asOf),
    };
  }

  /** Same split the live provider makes: `portfolio` rides the crypto (UTC) boundary */
  private calendarFor(key: SessionEquityKey): TradingCalendar {
    return key === 'stocks' ? this.input.calendars.stocks : this.input.calendars.crypto;
  }

  /**
   * The session basis, derived rather than sampled.
   *
   * `open_equity` sums every class's realized PnL before the boundary — an
   * account-level figure, matching the live provider's one blended broker
   * equity. Only the numerator is class-filtered.
   */
  private sessionBasisFor(
    key: SessionEquityKey,
    trades: readonly ClosedTrade[],
    asOf: Date,
    book: number,
  ): SessionBasis {
    const sessionStart = this.calendarFor(key).sessionStart(asOf).getTime();

    let realizedBefore = 0;
    let realizedSince = 0;
    for (const trade of trades) {
      if (trade.closed_at.getTime() > sessionStart) {
        // Half-open at the start, matching `realizedSince`'s `closed_at > ?`,
        // so consecutive sessions partition the timeline exactly once
        if (key === 'portfolio' || trade.asset_class === key) {
          realizedSince += trade.realized_pnl_net;
        }
      } else {
        realizedBefore += trade.realized_pnl_net;
      }
    }

    const openEquity = book + realizedBefore;
    // A non-positive denominator makes the fraction Infinity or NaN, both of
    // which compare false against the breaker's threshold — a wiped-out
    // account would read as "no loss" rather than a halt
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

  /** As `BrokerAccountStateProvider.consecutiveLosses`, over the control's own rows */
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
 * Long lots only: a short lot releases cash at a real venue and posts
 * margin instead, which would require modelling a margin ledger the
 * simulated adapter doesn't have. Treating a short as committing no cash
 * never overstates available cash.
 *
 * Entry fees on still-open lots are not netted here — they land in
 * `realized_pnl_net` when the lot closes, bounded to one round trip's cost.
 */
/** The durable home for the anchor — `SqliteAccountStateStore`'s shape, narrowed */
interface BookAnchorStore {
  /** The persisted anchor, or null before one was ever written */
  peakEquity(): number | null;
  /** First-write-wins: stores `equity` if absent, and returns the value in force */
  anchorEquity(equity: number, asOf: Date): number;
}

export interface ControlBookAnchorResolverInput {
  /** The LIVE arm's provider. Read exactly once, at first boot, and never again. */
  liveAccountState: AccountStateProvider;
  /** Keyed to `CONTROL_BOOK_ANCHOR_KEY` — never the live arm's `'default'` row */
  store: BookAnchorStore;
  /**
   * The declared book in the account's currency — used only when the live
   * observation is unusable, and only for that tick's return value. Never
   * handed to `store.anchorEquity`: `anchorEquity` is first-write-wins, so
   * persisting this on one transient read failure would pin the control's
   * book at the declared figure permanently.
   */
  fallbackBook: number;
  /**
   * The same `RiskConfig['live_book_ceiling']` `fallbackBook` is already
   * resolved through. Without this, the live-read anchor path read
   * `max(cash, peak_equity)` off the live account uncapped while the
   * fallback path was already capped, so the anchor and the live arm's own
   * sizing basis could diverge whenever live equity exceeded the ceiling.
   */
  liveBookCeiling?: RiskConfig['live_book_ceiling'];
}

/**
 * The anchor policy: persisted value if there is one, otherwise the live
 * arm's equity observed once and written first-write-wins, otherwise the
 * declared book.
 *
 * `max(cash, peak_equity)` rather than bare `cash`: `cash` is what's left
 * after deployment, so a restart taken while the live arm holds lots would
 * anchor the control low.
 *
 * A throw or non-positive reading falls back to the declared book without
 * persisting it: an account read that fails must not take the live arm's
 * tick down with it, nor foreclose a later tick's real anchor.
 */
export function buildControlBookAnchorResolver(
  input: ControlBookAnchorResolverInput,
): (asOf: Date) => Promise<number> {
  return async (asOf: Date): Promise<number> => {
    const persisted = input.store.peakEquity();
    if (persisted !== null && persisted > 0) return persisted;

    let observed: number;
    try {
      const live = await input.liveAccountState.getAccountState(asOf);
      observed = Math.max(live.cash, live.peak_equity);
    } catch {
      // Return the fallback for this tick without writing it: `anchorEquity`
      // is first-write-wins, so writing here would permanently pin the
      // anchor at the declared book on the strength of one transient failure
      return input.fallbackBook;
    }

    // The same ceiling `fallbackBook` is already resolved through, applied
    // to the live observation too, so the two paths cannot disagree on the
    // sizing basis. Left unapplied (not refused) when unverified: this
    // resolver also runs on the control arm's exit path, and a throw here
    // would block flat-by-close.
    const ceiling = input.liveBookCeiling;
    if (ceiling !== undefined && ceiling.same_currency_verified === true) {
      observed = Math.min(observed, ceiling.book);
    }

    if (!(Number.isFinite(observed) && observed > 0)) {
      // A successful read that came back unusable (zero/negative/non-finite)
      // is the same hazard as a throw — fallback for this tick only.
      return input.fallbackBook;
    }

    return input.store.anchorEquity(observed, asOf);
  };
}

/**
 * The realized high-water mark: the running max of `book +
 * cumulative-realized-so-far`, walked over `trades` in order.
 *
 * Summing all realized PnL to one net figure before maxing loses any peak
 * reached and then given back within the window (e.g. +250 then -300 nets
 * to -50, hiding the real peak of `book + 250`). Walking the ordered
 * sequence recovers it, which is also why this re-runs over the full trade
 * record on every call rather than resuming from an in-memory peak a
 * process restart wouldn't have.
 *
 * `trades` must be ordered by `closed_at` ascending —
 * `SqliteClosedTradeStore.getClosedTradesBetween` guarantees that.
 */
function realizedHighWaterMark(trades: readonly ClosedTrade[], book: number): number {
  let cumulative = 0;
  let peak = book;
  for (const trade of trades) {
    cumulative += trade.realized_pnl_net;
    peak = Math.max(peak, book + cumulative);
  }
  return peak;
}

function deployedCash(positions: readonly OpenPosition[]): number {
  return positions.reduce(
    (total, position) =>
      position.side === 'buy' ? total + position.avg_entry_price * position.filled_size : total,
    0,
  );
}
