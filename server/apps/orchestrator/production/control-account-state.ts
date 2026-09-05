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
 * arm-scoped reads — its `closed_trades` rows and its open lots — plus a
 * starting BOOK ANCHOR resolved exactly once (see `resolveBook`). That mirrors
 * the `arm = 'live'` scoping already applied one layer down rather than
 * inventing a second mechanism, and it means a control-arm figure can never be
 * moved by a live-arm fill.
 *
 * | Field | Derivation |
 * |---|---|
 * | `cash` | anchor + realized PnL to date − cash deployed in open long lots |
 * | `peak_equity` | running max of the cumulative realized curve (anchor + realized-to-date at each close, in trade order), floored at the anchor |
 * | `daily_basis` | (anchor + realized before the session open) as the denominator, realized since it as the numerator |
 * | `consecutive_losses` | the control's own closed trades, walked backwards |
 *
 * ## Four deliberate divergences from `AlpacaAccountStateProvider`
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
 * 4. **The starting book is the live arm's equity at first boot, not the
 *    declared £1,000.** A matched control has to start at the same capital as
 *    the arm it is matched against. Since #1112, both arms' Trader-ask sizing
 *    clamps to the SAME declared `capitalCeilingUsd` (`buildControlArmWiring`
 *    spreads it from the live arm's `TraderStepDeps` into the control's), so
 *    `sizingEquity`'s `min(equity, ceiling)` only lands both arms on the same
 *    clamped figure while this anchor stays comfortably above that ceiling —
 *    an anchor at or below the ceiling would remove the margin the clamp
 *    relies on. The anchor is read ONCE and persisted first-write-wins, so
 *    this is a single boot-time observation and not an ongoing coupling.
 *    Whether anchoring at the ceiling itself (rather than at the live arm's
 *    much larger real equity) is now safe post-#1112 is an open sizing
 *    question escalated to the owner, not settled here.
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
   * The book the control arm's own account STARTS at, resolved once — on the
   * first `getAccountState` — and then never consulted again.
   *
   * A resolver rather than a constant because the anchor has to be the LIVE
   * arm's starting equity, and that is not known at construction. It was a
   * constant (`LIVE_BOOK_GBP`) in this module's first version, and `yarn smoke`
   * caught what that costs — measured BEFORE #1112, when paper's
   * `capitalCeilingUsd` did not exist and neither arm's Trader ask was
   * clamped: the live arm sized off its full ~$100,000 broker equity while a
   * control anchored at £1,000 sized off £1,000 alone, so every control
   * intent came back `rounds_to_zero_shares` and the arm took no trade at
   * all. A control that never trades is indistinguishable from a control that
   * never found a setup — the exact row `formatArmComparison` warns about, and
   * a whole soak wasted.
   *
   * Since #1112, both arms clamp to the SAME declared `capitalCeilingUsd`, so
   * this anchor's job is narrower than it was when the measurement above was
   * taken: it only has to stay above that shared ceiling for both arms to
   * clamp to the identical figure regardless of which one's raw equity is
   * bigger. Anchoring directly at the ceiling instead of at the live arm's
   * (much larger) real equity might be safe now, or might still starve the
   * control once `whole_share_sizing` floors a smaller notional — that is
   * the sizing question escalated to the owner, not decided here, so this
   * resolver keeps observing the live arm's real equity rather than the
   * ceiling.
   *
   * "Matched control" means the same starting capital and then INDEPENDENT
   * evolution. Resolving once gives that: the anchor is a boot-time observation,
   * never a per-tick read, so no live fill can move a control-arm figure. The
   * composition root persists the resolved value (`CONTROL_BOOK_ANCHOR_KEY`,
   * first-write-wins) so a restart re-reads the original anchor rather than
   * re-anchoring to the live arm's by-then-different equity — without which the
   * control's book would slowly track the live arm's performance across a
   * multi-restart soak.
   */
  resolveBook: (asOf: Date) => Promise<number>;
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
  /** The resolved anchor. Null until the first `getAccountState`; set once. */
  #book: number | null = null;

  constructor(private readonly input: ControlArmAccountStateProviderInput) {}

  /**
   * The anchor, resolved on first use and cached for the life of the process.
   *
   * Cached on the INSTANCE and not re-read even though the composition root's
   * resolver is itself idempotent: the point is that a live-arm figure is read
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
    // One read, reused by all four figures — the live provider's own posture
    // (`realizedFor` and `consecutiveLosses` both read the same store) without
    // its four separate round trips.
    const book = await this.book(asOf);
    const trades = this.input.closedTrades.getClosedTradesBetween(EPOCH, asOf);
    const positions = await this.input.getOpenPositions();

    const realized = trades.reduce((total, trade) => total + trade.realized_pnl_net, 0);
    const equityAtCost = book + realized;

    return {
      cash: equityAtCost - deployedCash(positions),
      // #972 fix 1 — derived FRESH from the full ordered trade curve on every
      // cold read, not carried in a running field that a restart resets to
      // the anchor. `trades` is already `EPOCH..asOf`, i.e. the whole record,
      // and `SqliteClosedTradeStore.getClosedTradesBetween` orders it by
      // `closed_at` — see `realizedHighWaterMark` below for why that ordering
      // is load-bearing here.
      peak_equity: realizedHighWaterMark(trades, book),
      daily_basis: {
        crypto: this.sessionBasisFor('crypto', trades, asOf, book),
        stocks: this.sessionBasisFor('stocks', trades, asOf, book),
        portfolio: this.sessionBasisFor('portfolio', trades, asOf, book),
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
    book: number,
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

    const openEquity = book + realizedBefore;
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
/** The durable home for the anchor — `SqliteAccountStateStore`'s shape, narrowed. */
export interface BookAnchorStore {
  /** The persisted anchor, or null before one was ever written. */
  peakEquity(): number | null;
  /** First-write-wins: stores `equity` if absent, and returns the value in force. */
  anchorEquity(equity: number, asOf: Date): number;
}

export interface ControlBookAnchorResolverInput {
  /** The LIVE arm's provider. Read exactly once, at first boot, and never again. */
  liveAccountState: AccountStateProvider;
  /** Keyed to `CONTROL_BOOK_ANCHOR_KEY` — never the live arm's `'default'` row. */
  store: BookAnchorStore;
  /**
   * `LIVE_BOOK_GBP` (or `config.riskConfig.live_book_ceiling?.book`). Used
   * only when the live observation is unusable — and, per #972 fix 2, used
   * for THAT TICK'S return value only. It is never handed to
   * `store.anchorEquity`: `anchorEquity` is first-write-wins, so persisting
   * the fallback on what may be one transient read failure would pin the
   * control's book at the declared figure permanently, even once the live
   * account becomes readable again on a later tick. Only a successful,
   * usable live observation is ever persisted.
   */
  fallbackBook: number;
  /**
   * #972 fix 3 — the SAME `RiskConfig['live_book_ceiling']` the fallback
   * above is already resolved through (`fallbackBook` at the composition root
   * is `config.riskConfig.live_book_ceiling?.book ?? LIVE_BOOK_GBP`). Without
   * this, the primary (live-read) anchor path read `max(cash, peak_equity)`
   * off the live account UNCAPPED while the fallback path was already capped
   * — so the anchor and the live arm's own sizing basis could diverge
   * whenever the live account's equity exceeded the ceiling. Optional: most
   * callers (every test fixture that predates #972, and any composition that
   * never sets `live_book_ceiling`) leave the live-read path exactly as it
   * was.
   */
  liveBookCeiling?: RiskConfig['live_book_ceiling'];
}

/**
 * The anchor policy, in one testable place: persisted value if there is one,
 * otherwise the live arm's equity observed once and written first-write-wins,
 * otherwise the declared book.
 *
 * `max(cash, peak_equity)` rather than bare `cash`: `cash` is what is left after
 * deployment, so a restart taken while the live arm holds lots would anchor the
 * control low. `peak_equity` is the account's scale and is persisted; on a flat
 * boot the two agree exactly, which is the case this normally runs in.
 *
 * A throw or a non-positive reading falls back to the declared book WITHOUT
 * persisting it (#972 fix 2 — see `fallbackBook`'s doc comment): this runs on
 * the first decision tick, and an account read that fails must not take the
 * live arm's tick down with it, nor may it foreclose a later tick's real
 * anchor. The fallback is the conservative direction — a small book
 * under-trades, it does not over-trade.
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
      // #972 fix 2 — return the fallback for THIS tick without writing it.
      // `store.anchorEquity` is first-write-wins, so writing here would
      // permanently pin the anchor at the declared book on the strength of
      // one transient failure.
      return input.fallbackBook;
    }

    // #972 fix 3 — the same ceiling `fallbackBook` is already resolved
    // through, applied to the live observation too, so the two paths cannot
    // disagree on the sizing basis. `same_currency_verified` gates the
    // comparison exactly as it does in `liveBookCeiling`/`perSubclassDeploymentCap`
    // (risk-manager/index.ts) — EXCEPT that gate throws on an unverified
    // ceiling and this one does not: `liveBookCeiling` lives in
    // `ENTRY_CAP_GATES`, which only ever sees entries, while this resolver is
    // reached from `getAccountState` on the control arm's decision path for
    // exits too, and a throw here would block flat-by-close the same way a
    // guard above an early return would. So an unverified ceiling is left
    // unapplied rather than refused outright.
    const ceiling = input.liveBookCeiling;
    if (ceiling !== undefined && ceiling.same_currency_verified === true) {
      observed = Math.min(observed, ceiling.book);
    }

    if (!(Number.isFinite(observed) && observed > 0)) {
      // A successful read that came back unusable (zero/negative/non-finite)
      // is the same hazard as a throw: persisting it would pin the anchor at
      // a nonsense value forever. Fallback for this tick only, same as above.
      return input.fallbackBook;
    }

    return input.store.anchorEquity(observed, asOf);
  };
}

/**
 * The realized high-water mark (#972 fix 1): the running max of `book +
 * cumulative-realized-so-far`, walked over `trades` IN ORDER.
 *
 * The bug this replaces summed all realized PnL to a single net figure and
 * maxed that ONE point against an in-memory running field — which loses any
 * peak that was reached and then given back within the SAME window, because
 * summing collapses the sequence before the max ever sees the high point.
 * Concretely: +250 then -300 nets to -50, so `max(book, book - 50)` reports
 * `book`, silently losing the real peak of `book + 250`. Walking the ordered
 * sequence and taking the max at every step is the only way to recover a
 * peak that intermediate closes reached and then gave back — which is also
 * why this has to be re-run over the FULL trade record on every call rather
 * than resumed from a peak held in memory: an in-memory value is exactly what
 * a process restart does not have.
 *
 * `trades` MUST be ordered by `closed_at` ascending for this to be correct —
 * `SqliteClosedTradeStore.getClosedTradesBetween` guarantees that (`ORDER BY
 * closed_at`), and every caller here reads through that store.
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
