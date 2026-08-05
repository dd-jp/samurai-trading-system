/**
 * The real `AccountStateProvider` (#276) — closes the seam `direct-bind.ts`
 * declared and nothing implemented. See docs/specs/transport-layer-spec.md
 * ("Module: AccountStateProvider", stories 23-25).
 *
 * Not one data source but four narrow ones, exactly as the spec splits them:
 *
 * | Field | Source |
 * |---|---|
 * | `cash` | Alpaca `GET /v2/account` — the broker's own ledger, not a reimplementation |
 * | `peak_equity` | locally persisted running max (`account_state` table) — Alpaca has no such field |
 * | `daily_basis` | locally persisted per-class session snapshots (`session_equity`) + `closed_trades` |
 * | `consecutive_losses` | walked backwards through the existing `ClosedTrade` store — no new ledger |
 *
 * ## GAP-8 resolved: the daily figure is local now (#332)
 *
 * This provider used to return Alpaca's single blended `equity`/`last_equity`
 * figure, with a one-shot `warn` naming the assumption. That is gone.
 *
 * The problem was never the arithmetic, it was the boundary: one blended
 * account figure carries ONE reset boundary, and this portfolio has two —
 * risk-manager-spec.md asks for UTC-day semantics for crypto and market-day for
 * stocks. Worse, per #260 Alpaca's actual reset boundary was never verified
 * against a live account, and `SMOKE_TEST_UNIVERSE` is BTC-USD, so the first
 * paper run sat precisely on the ambiguous side.
 *
 * So the boundary is now one this system owns — `TradingCalendar.sessionStart`
 * (#331), asked per class — and the denominator is a locally persisted snapshot
 * of equity at that boundary (`session_equity`, migration 0009). `cash` and
 * `equity` still come from `GET /v2/account`; only the *daily* figure became
 * local.
 *
 * This provider deliberately stops one step short of the percentage. It emits a
 * `SessionBasis` — the open-equity denominator and the realized numerator — and
 * `computePortfolioView` adds the unrealized mark-to-market term and divides,
 * because it has already fetched the marks for its exposure math and #332
 * requires they not be fetched twice.
 */
import type { AlpacaClient } from '../../execution/index.js';
import type { TradingCalendar } from '../../market-data-service/index.js';
import type { SessionBasis, SessionBasisByClass } from '../../risk-manager/index.js';
import type { ClosedTrade } from '../../shared/index.js';
import type { SqliteAccountStateStore } from '../sqlite-account-state-store.js';
import type { SessionEquityKey, SqliteSessionEquityStore } from '../sqlite-session-equity-store.js';
import type { Logger } from '../types.js';
import type { AccountStateProvider } from './direct-bind.js';

/** The `ClosedTrade` read this provider needs — a subset of `SharedStore`. */
export interface ClosedTradeReader {
  getClosedTradesBetween(from: Date, to: Date): ClosedTrade[];
}

export interface AlpacaAccountStateProviderInput {
  client: AlpacaClient;
  store: SqliteAccountStateStore;
  sessionEquity: SqliteSessionEquityStore;
  closedTrades: ClosedTradeReader;
  logger: Logger;
  /**
   * Session boundaries per asset class (#331). Two calendars, not one: the
   * whole point of #332 is that crypto resets at 00:00 UTC and stocks at the
   * prior 16:00 ET close, and a single injected calendar would silently
   * measure a weekend's crypto PnL from Friday afternoon.
   */
  calendars: { crypto: TradingCalendar; stocks: TradingCalendar };
  /**
   * Gates cold-start behaviour. In `paper`/`backtest` a missing snapshot is
   * seeded from current equity and trading continues; in `live` the figure is
   * reported unknown instead. Precedent: `BreakerConfig.auto_rearm` is likewise
   * consulted only in `backtest`.
   */
  mode: 'live' | 'paper' | 'backtest';
  /**
   * How far back to walk for the loss streak. A streak longer than this
   * window is reported as this many losses — the breaker's threshold is a
   * small integer, so the cap only ever affects a number already far past it.
   * Default 365 days.
   */
  lossStreakWindowDays?: number;
}

const DEFAULT_LOSS_STREAK_WINDOW_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export class AlpacaAccountStateProvider implements AccountStateProvider {
  /**
   * Keys whose snapshot this process seeded mid-session rather than observed at
   * a boundary. In `live` these stay unknown until a real boundary crossing
   * supersedes the seed — see `sessionBasisFor`.
   */
  private readonly coldSeeded = new Set<SessionEquityKey>();

  constructor(private readonly input: AlpacaAccountStateProviderInput) {}

  async getAccountState(asOf: Date): Promise<{
    cash: number;
    peak_equity: number;
    daily_basis: SessionBasisByClass;
    consecutive_losses: number;
  }> {
    const account = await this.input.client.getAccount();

    const cash = parseMoney(account.cash, 'cash');
    const equity = parseMoney(account.equity, 'equity');

    // Raise the high-water mark before reading it, so a new all-time high is
    // reflected in the very tick that set it rather than one tick later.
    const peakEquity = this.input.store.recordEquity(equity, asOf);

    return {
      cash,
      peak_equity: peakEquity,
      daily_basis: {
        crypto: this.sessionBasisFor('crypto', equity, asOf),
        stocks: this.sessionBasisFor('stocks', equity, asOf),
        portfolio: this.sessionBasisFor('portfolio', equity, asOf),
      },
      consecutive_losses: this.consecutiveLosses(asOf),
    };
  }

  /**
   * The session boundary for a key. `portfolio` shares the crypto calendar
   * because #332 specifies the portfolio-level figure as the UTC one — the
   * account holds crypto that never stops trading, so a 16:00 ET anchor would
   * leave overnight crypto moves stranded outside the portfolio's own day.
   *
   * A consequence worth naming rather than mistaking for a bug: the `crypto`
   * and `portfolio` rows always carry identical `open_equity`/`open_at`. They
   * differ in what is summed against them, not in when they reset.
   */
  private calendarFor(key: SessionEquityKey): TradingCalendar {
    return key === 'stocks' ? this.input.calendars.stocks : this.input.calendars.crypto;
  }

  private realizedFor(key: SessionEquityKey, openAt: Date): number {
    return key === 'portfolio'
      ? this.input.sessionEquity.realizedSinceAllClasses(openAt)
      : this.input.sessionEquity.realizedSince(key, openAt);
  }

  /** The unknown a live cold seed yields, until a real boundary supersedes it. */
  private coldSeedUnknown(key: SessionEquityKey): SessionBasis {
    return {
      known: false,
      reason:
        `daily PnL for '${key}' is unknown: its session-open equity was seeded mid-session ` +
        'on a live cold start, so no equity was ever observed at this session boundary',
    };
  }

  /**
   * Advances the stored snapshot across a session boundary, then reports the
   * basis for the current session.
   *
   * The advance is strictly `stored < sessionStart`, and writes `open_at =
   * sessionStart` — not `asOf`. Since `sessionStart(sessionStart(t)) ===
   * sessionStart(t)` (port doc), that makes the advance idempotent: every
   * further tick inside the same session compares equal and leaves the snapshot
   * alone, so the open is captured once per session rather than drifting
   * forward on every tick.
   */
  private sessionBasisFor(key: SessionEquityKey, equity: number, asOf: Date): SessionBasis {
    const sessionStart = this.calendarFor(key).sessionStart(asOf);
    const stored = this.input.sessionEquity.get(key);

    if (stored === null) {
      return this.coldStart(key, equity, sessionStart);
    }

    let openEquity = stored.open_equity;
    let openAt = stored.open_at;

    if (openAt.getTime() < sessionStart.getTime()) {
      this.input.sessionEquity.put(key, equity, sessionStart);
      openEquity = equity;
      openAt = sessionStart;
      // A boundary actually observed by this process supersedes any earlier
      // mid-session seed: from here the snapshot is a real session open.
      this.coldSeeded.delete(key);
    }

    if (this.coldSeeded.has(key)) {
      return this.coldSeedUnknown(key);
    }

    // A non-positive denominator would make the fraction Infinity or NaN, and
    // both compare false against the breaker's threshold — the figure would
    // read as "no loss" through an account that has none of itself left. There
    // is no honest percentage against a zero base, so say so.
    if (!(openEquity > 0)) {
      return {
        known: false,
        reason:
          `daily PnL for '${key}' is unknown: session-open equity was ${openEquity}, ` +
          'and a percentage change against a non-positive base has no meaning',
      };
    }

    return { known: true, open_equity: openEquity, realized_pnl: this.realizedFor(key, openAt) };
  }

  /**
   * No snapshot at all — a fresh DB, or a restart whose first tick lands after
   * a boundary this process never saw.
   *
   * Both modes seed the row, so the boundary machinery converges from the next
   * crossing onward. They differ in what they *report* for the session already
   * in progress, whose true open equity is simply not recoverable:
   *
   * - `paper`/`backtest` — report it against the seed and log a `warn`. The
   *   cost of being wrong is a mis-sized paper trade.
   * - `live` — report unknown, for the remainder of this session. The cost of
   *   being wrong is real money traded through a daily-loss breaker that cannot
   *   see the loss, so an unknown that blocks entries beats a plausible number
   *   measured from the wrong base.
   */
  private coldStart(key: SessionEquityKey, equity: number, sessionStart: Date): SessionBasis {
    this.input.sessionEquity.put(key, equity, sessionStart);

    if (this.input.mode === 'live') {
      this.coldSeeded.add(key);
      this.input.logger.log({
        trace_id: 'account-state',
        stage: 'orchestrator',
        level: 'warn',
        message:
          `daily PnL for '${key}' is UNKNOWN and will block new entries: no session-open ` +
          `equity was recorded for the session starting ${sessionStart.toISOString()}, and ` +
          'live mode will not measure a daily loss from a mid-session seed (#332)',
      });
      return this.coldSeedUnknown(key);
    }

    this.input.logger.log({
      trace_id: 'account-state',
      stage: 'orchestrator',
      level: 'warn',
      message:
        `seeded session-open equity for '${key}' from current equity ${equity} at ` +
        `${sessionStart.toISOString()} — no snapshot existed, so this session's daily PnL is ` +
        `measured from a mid-session base (${this.input.mode} mode; live would report unknown)`,
    });

    return {
      known: true,
      open_equity: equity,
      realized_pnl: this.realizedFor(key, sessionStart),
    };
  }

  /**
   * Walks realized trades backwards from `asOf`, counting losses until a
   * non-loss breaks the streak (spec story 25).
   *
   * A break-even trade (`realized_pnl_net === 0`) breaks the streak rather
   * than extending or being skipped: the breaker this feeds exists to stop a
   * run of *losing* decisions, and a flat trade is not one.
   */
  private consecutiveLosses(asOf: Date): number {
    const windowDays = this.input.lossStreakWindowDays ?? DEFAULT_LOSS_STREAK_WINDOW_DAYS;
    const from = new Date(asOf.getTime() - windowDays * MS_PER_DAY);
    const trades = this.input.closedTrades.getClosedTradesBetween(from, asOf);

    let streak = 0;
    for (let i = trades.length - 1; i >= 0; i -= 1) {
      const trade = trades[i];
      if (trade === undefined || trade.realized_pnl_net >= 0) break;
      streak += 1;
    }
    return streak;
  }
}

/**
 * Alpaca returns money as decimal strings. An unparseable one must not become
 * a silent `NaN`: `cash` feeds equity, `equity` feeds the drawdown
 * denominator, and NaN propagates through both without ever failing a
 * comparison — the breaker would simply never trip.
 *
 * This is the whole boundary. `getAccount()` has exactly one consumer — the
 * two calls above — so every string Alpaca sends passes through here before
 * it can reach the store or the breakers (PR #301 review, deepseek).
 */
function parseMoney(raw: unknown, field: string): number {
  const value = toFiniteNumber(raw);
  if (!Number.isFinite(value)) {
    throw new Error(
      `Alpaca GET /v2/account returned an unparseable '${field}': ${JSON.stringify(raw)}. ` +
        'Refusing to feed a non-numeric account figure to the circuit breakers.',
    );
  }
  return value;
}

/**
 * `unknown` in, because this is JSON off the wire: the declared type says
 * `string`, but nothing enforces that at the boundary and a malformed response
 * must fail loudly rather than crash on `.trim()`.
 *
 * Two conversions are wrong here in opposite directions, so neither is used
 * alone:
 *
 * - `Number.parseFloat` stops at the first invalid character, so a
 *   thousands-separated `'100,000.50'` becomes `100` — wrong by three orders
 *   of magnitude on the figure that divides the drawdown breaker, and never
 *   `NaN`, so the guard above would pass it.
 * - `Number` rejects that trailing garbage, but turns `''` and `'  '` into
 *   `0`, which sails through the finite check as a genuine zero equity — and a
 *   zero equity is exactly the non-positive denominator `sessionBasisFor`
 *   answers "unknown" to.
 *
 * So: reject blank explicitly, then let `Number` be strict about the rest.
 */
function toFiniteNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return Number.NaN;

  const trimmed = raw.trim();
  if (trimmed === '') return Number.NaN;

  return Number(trimmed);
}
