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
import type { AlpacaClient } from '../../../pipeline/execution/index.js';
import type { SessionBasis, SessionBasisByClass } from '../../../pipeline/risk-manager/index.js';
import type { TradingCalendar } from '../../../providers/market-data-service/index.js';
import type { ClosedTrade } from '../../../shared/index.js';
import type { SqliteAccountStateStore } from '../sqlite-account-state-store.js';
import type { SqliteDailyEquityStore } from '../sqlite-daily-equity-store.js';
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
  /**
   * The append-only daily equity series (#345, migration 0011).
   *
   * REQUIRED, not optional, and that is the point of the ticket. A return
   * series cannot be backfilled — equity that was never recorded on the day is
   * gone — so a deployment that quietly composed this provider without a series
   * writer would spend the whole soak looking healthy and end it with nothing to
   * compute metrics from. An optional field makes that omission invisible; a
   * required one makes it a compile error.
   *
   * Written on the `portfolio` boundary only (see `sessionBasisFor`).
   */
  dailyEquity: SqliteDailyEquityStore;
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
   * When this process started. Decides whether a snapshot it writes counts as
   * a real session open: the process can only have observed the boundary if it
   * was already running at it (`startedAt <= sessionStart`).
   *
   * This is what separates a normal advance — process up, boundary crossed
   * under it, snapshot taken on the next tick — from #332's second cold-start
   * case, "a restart with the boundary already passed", where the same advance
   * would otherwise write a mid-session equity and call it the open.
   */
  startedAt: Date;
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
   * `key@open_at` pairs already warned about, so a mid-session base is
   * announced once per session rather than once per tick. Purely about log
   * volume — the trust verdict itself lives in the table, not here.
   */
  private readonly warnedSessions = new Set<string>();

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
   *
   * Whether the resulting snapshot counts as a real session open is a separate
   * question from whether it is current, and it is answered once — at write
   * time, from `startedAt` — then persisted. #332 treats BOTH "no row at all"
   * and "a restart with the boundary already passed" as cold starts; the second
   * arrives here as an ordinary stale-row advance, and only `startedAt` tells
   * it apart from the healthy case.
   */
  private sessionBasisFor(key: SessionEquityKey, equity: number, asOf: Date): SessionBasis {
    const sessionStart = this.calendarFor(key).sessionStart(asOf);
    const stored = this.input.sessionEquity.get(key);

    // The process can only have seen the open if it was already up at it. A
    // fresh DB is never an observation either: nothing sampled equity then, so
    // the row is being invented now regardless of how long this process has run.
    const observedAtBoundary =
      stored !== null && this.input.startedAt.getTime() <= sessionStart.getTime();

    // #345 — the same boundary, sampled into a series instead of over itself.
    //
    // `portfolio` only. The three keys share this method but not this concern:
    // `stocks` rides the 16:00 ET close, which skips weekends and holidays, so
    // its consecutive boundaries are not evenly spaced and a Sharpe annualized
    // over them is wrong by construction. `crypto` is the same UTC midnight as
    // `portfolio` and would duplicate every row (the two keys always carry
    // identical `open_equity`/`open_at` — see `calendarFor`). So the series is
    // anchored to the portfolio-level UTC day, exactly 86,400,000 ms per step.
    //
    // Attempted on EVERY tick rather than only inside the advance branch below,
    // and idempotent because `append` is `DO NOTHING` on conflict. Tying it to
    // the advance would lose a day in the one case that matters most: a process
    // that comes up mid-session finds `session_equity` already current for this
    // session, takes no advance, and would leave a hole in the series that can
    // never be filled. A late sample flagged `observed_at_boundary = 0` is worth
    // more than a gap — the gap breaks the spacing of everything after it.
    if (key === 'portfolio') {
      this.input.dailyEquity.append(sessionStart, equity, asOf, observedAtBoundary);
    }

    let { open_equity: openEquity, open_at: openAt } = stored ?? {
      open_equity: equity,
      open_at: sessionStart,
    };
    let trustworthy = stored?.observed_at_boundary ?? false;

    if (stored === null || openAt.getTime() < sessionStart.getTime()) {
      this.input.sessionEquity.put(key, equity, sessionStart, observedAtBoundary);
      openEquity = equity;
      openAt = sessionStart;
      trustworthy = observedAtBoundary;
    }

    if (!trustworthy) {
      return this.midSessionBase(key, openEquity, openAt, sessionStart);
    }

    // A non-positive denominator would make the fraction Infinity or NaN, and
    // both compare false against the breaker's threshold — the figure would
    // read as "no loss" through an account that has none of itself left. There
    // is no honest percentage against a zero base, so say so.
    if (!(openEquity > 0)) {
      return this.nonPositiveBase(key, openEquity);
    }

    return { known: true, open_equity: openEquity, realized_pnl: this.realizedFor(key, openAt) };
  }

  private nonPositiveBase(key: SessionEquityKey, openEquity: number): SessionBasis {
    return {
      known: false,
      reason:
        `daily PnL for '${key}' is unknown: session-open equity was ${openEquity}, ` +
        'and a percentage change against a non-positive base has no meaning',
    };
  }

  /**
   * The snapshot in force was sampled inside the session, not at its start —
   * a fresh DB, or a restart that came up after the boundary had passed.
   *
   * The true open equity is not recoverable: historical `cash` is stored
   * nowhere, so there is nothing to reconstruct it from. What differs by mode
   * is what gets reported for the session already in progress:
   *
   * - `paper`/`backtest` — report it against the mid-session base and warn.
   *   The cost of being wrong is a mis-sized paper trade.
   * - `live` — report unknown. The cost of being wrong is real money traded
   *   through a daily-loss breaker measuring from a base captured *after* the
   *   loss it exists to catch, which reads as a flat day. An unknown that
   *   blocks entries beats a plausible number from the wrong base.
   *
   * Both paths converge at the next boundary this process is up for, which
   * writes a genuine open and clears the flag.
   */
  private midSessionBase(
    key: SessionEquityKey,
    openEquity: number,
    openAt: Date,
    sessionStart: Date,
  ): SessionBasis {
    const once = `${key}@${sessionStart.toISOString()}`;
    const firstTime = !this.warnedSessions.has(once);
    if (firstTime) this.warnedSessions.add(once);

    if (this.input.mode === 'live') {
      if (firstTime) {
        this.input.logger.log({
          trace_id: 'account-state',
          stage: 'orchestrator',
          level: 'warn',
          message:
            `daily PnL for '${key}' is UNKNOWN: no equity was observed at the session start ` +
            `${sessionStart.toISOString()} (fresh store, or a restart after the boundary had ` +
            'passed), and live mode will not measure a daily loss from a mid-session base. ' +
            'It stays unknown until the next boundary this process is running for (#332)',
        });
      }
      return {
        known: false,
        reason:
          `daily PnL for '${key}' is unknown: its session-open equity was sampled mid-session, ` +
          `not at the session start ${sessionStart.toISOString()}`,
      };
    }

    if (firstTime) {
      this.input.logger.log({
        trace_id: 'account-state',
        stage: 'orchestrator',
        level: 'warn',
        message:
          `session-open equity for '${key}' is a mid-session base (${openEquity}) rather than ` +
          `an observation at ${sessionStart.toISOString()}, so this session's daily PnL is ` +
          `measured from it (${this.input.mode} mode; live would report unknown)`,
      });
    }

    // Same non-positive guard as the trusted path: a zero base is Infinity or
    // NaN, which compares false in the breaker and reads as no loss at all.
    if (!(openEquity > 0)) {
      return this.nonPositiveBase(key, openEquity);
    }

    return {
      known: true,
      open_equity: openEquity,
      realized_pnl: this.realizedFor(key, openAt),
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
