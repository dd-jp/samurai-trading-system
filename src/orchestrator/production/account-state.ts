/**
 * The real `AccountStateProvider` (#276) — closes the seam `direct-bind.ts`
 * declared and nothing implemented. See docs/specs/transport-layer-spec.md
 * ("Module: AccountStateProvider", stories 23-25).
 *
 * Not one data source but three narrow ones, exactly as the spec splits them:
 *
 * | Field | Source |
 * |---|---|
 * | `cash` | Alpaca `GET /v2/account` — the broker's own ledger, not a reimplementation |
 * | `daily_pnl_pct` | Alpaca `equity`/`last_equity` — **semantics unresolved, see below** |
 * | `peak_equity` | locally persisted running max (`account_state` table) — Alpaca has no such field |
 * | `consecutive_losses` | walked backwards through the existing `ClosedTrade` store — no new ledger |
 *
 * ## The `daily_pnl_pct` caveat (cross-verify 2026-07-31, GAP-8)
 *
 * This provider returns Alpaca's single blended account figure. That is the
 * MVP option (a), and it is **not** a settled decision — risk-manager-spec.md
 * asks for session-scoped semantics (UTC day for crypto, market day for
 * stocks), while Alpaca gives one number for the whole account whose reset
 * boundary is, per #260, unverified against a live account. Since
 * `SMOKE_TEST_UNIVERSE` is BTC-USD, the first paper run sits precisely on the
 * ambiguous side.
 *
 * Rather than pick silently, the provider logs a `warn` naming the
 * assumption on first use, so the figure feeding a circuit breaker can never
 * be mistaken for a verified one. Option (b) — a locally persisted
 * UTC-midnight equity snapshot — is a `daily_open_equity`/`daily_open_at`
 * column pair on the same table plus a different expression here.
 */
import type { AlpacaClient } from '../../execution/index.js';
import type { ClosedTrade } from '../../shared/index.js';
import type { SqliteAccountStateStore } from '../sqlite-account-state-store.js';
import type { Logger } from '../types.js';
import type { AccountStateProvider } from './direct-bind.js';

/** The `ClosedTrade` read this provider needs — a subset of `SharedStore`. */
export interface ClosedTradeReader {
  getClosedTradesBetween(from: Date, to: Date): ClosedTrade[];
}

export interface AlpacaAccountStateProviderInput {
  client: AlpacaClient;
  store: SqliteAccountStateStore;
  closedTrades: ClosedTradeReader;
  logger: Logger;
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
  private warnedAboutDailyPnl = false;

  constructor(private readonly input: AlpacaAccountStateProviderInput) {}

  async getAccountState(asOf: Date): Promise<{
    cash: number;
    peak_equity: number;
    daily_pnl_pct: number;
    consecutive_losses: number;
  }> {
    const account = await this.input.client.getAccount();

    const cash = parseMoney(account.cash, 'cash');
    const equity = parseMoney(account.equity, 'equity');
    const lastEquity = parseMoney(account.last_equity, 'last_equity');

    // Raise the high-water mark before reading it, so a new all-time high is
    // reflected in the very tick that set it rather than one tick later.
    const peakEquity = this.input.store.recordEquity(equity, asOf);

    return {
      cash,
      peak_equity: peakEquity,
      daily_pnl_pct: this.dailyPnlPct(equity, lastEquity),
      consecutive_losses: this.consecutiveLosses(asOf),
    };
  }

  private dailyPnlPct(equity: number, lastEquity: number): number {
    if (!this.warnedAboutDailyPnl) {
      this.warnedAboutDailyPnl = true;
      this.input.logger.log({
        trace_id: 'account-state',
        stage: 'orchestrator',
        level: 'warn',
        message:
          "daily_pnl_pct is Alpaca's blended account figure; its reset boundary is unverified " +
          'against a live account and may not match the UTC-day semantics risk-manager-spec.md ' +
          'states for crypto (cross-verify 2026-07-31, GAP-8 — open decision)',
      });
    }

    // A zero or negative prior equity would make this Infinity/NaN and carry
    // it straight into `CircuitBreakers.evaluate`, where a NaN comparison is
    // false and would silently NOT trip the daily-loss breaker. Zero is the
    // honest answer: with no prior equity there is no percentage change.
    if (lastEquity <= 0) return 0;

    return (equity - lastEquity) / lastEquity;
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
 * three calls above — so every string Alpaca sends passes through here before
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
 *   zero `last_equity` is precisely the case `dailyPnlPct` answers `0` to.
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
