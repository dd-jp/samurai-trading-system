import type { AlpacaBrokerClient } from '../../../pipeline/execution/index.js';
import type { SessionBasis, SessionBasisByClass } from '../../../pipeline/risk-manager/index.js';
import type { TradingCalendar } from '../../../providers/market-data-service/index.js';
import type { ClosedTrade } from '../../../shared/index.js';
import { currentTraceId } from '../../../shared/index.js';
import type { SqliteAccountStateStore } from '../sqlite-account-state-store.js';
import type { SqliteDailyEquityStore } from '../sqlite-daily-equity-store.js';
import type { SessionEquityKey, SqliteSessionEquityStore } from '../sqlite-session-equity-store.js';
import type { Logger } from '../types.js';
import type { AccountStateProvider } from './direct-bind.js';

export interface ClosedTradeReader {
  getClosedTradesBetween(from: Date, to: Date): ClosedTrade[];
}

export interface AccountFunding {
  readonly cash: number;
  readonly equity: number;
  readonly currency: string;
}

export interface AccountFundingSource {
  readFunding(): Promise<AccountFunding>;
}

const ALPACA_ACCOUNT_CURRENCY = 'USD';

export function alpacaFunding(client: AlpacaBrokerClient): AccountFundingSource {
  return {
    readFunding: async () => {
      const account = await client.getAccount();
      return {
        cash: parseMoney(account.cash, 'cash'),
        equity: parseMoney(account.equity, 'equity'),
        currency: ALPACA_ACCOUNT_CURRENCY,
      };
    },
  };
}

export interface BrokerAccountStateProviderInput {
  funding: AccountFundingSource;
  store: SqliteAccountStateStore;
  sessionEquity: SqliteSessionEquityStore;
  dailyEquity: SqliteDailyEquityStore;
  closedTrades: ClosedTradeReader;
  logger: Logger;
  calendars: { crypto: TradingCalendar; stocks: TradingCalendar };
  mode: 'live' | 'paper' | 'backtest';
  startedAt: Date;
  lossStreakWindowDays?: number;
}

const DEFAULT_LOSS_STREAK_WINDOW_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export class BrokerAccountStateProvider implements AccountStateProvider {
  private readonly warnedSessions = new Set<string>();

  constructor(private readonly input: BrokerAccountStateProviderInput) {}

  async getAccountState(asOf: Date): Promise<{
    cash: number;
    peak_equity: number;
    daily_basis: SessionBasisByClass;
    consecutive_losses: number;
  }> {
    const { cash, equity } = await this.input.funding.readFunding();

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

  private calendarFor(key: SessionEquityKey): TradingCalendar {
    return key === 'stocks' ? this.input.calendars.stocks : this.input.calendars.crypto;
  }

  private realizedFor(key: SessionEquityKey, openAt: Date): number {
    return key === 'portfolio'
      ? this.input.sessionEquity.realizedSinceAllClasses(openAt)
      : this.input.sessionEquity.realizedSince(key, openAt);
  }

  private sessionBasisFor(key: SessionEquityKey, equity: number, asOf: Date): SessionBasis {
    const sessionStart = this.calendarFor(key).sessionStart(asOf);
    const stored = this.input.sessionEquity.get(key);

    const observedAtBoundary =
      stored !== null && this.input.startedAt.getTime() <= sessionStart.getTime();

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
          trace_id: currentTraceId() ?? 'account-state',
          stage: 'orchestrator',
          event: 'daily_pnl_unknown',
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
        trace_id: currentTraceId() ?? 'account-state',
        stage: 'orchestrator',
        event: 'session_open_equity_midsession',
        level: 'warn',
        message:
          `session-open equity for '${key}' is a mid-session base (${openEquity}) rather than ` +
          `an observation at ${sessionStart.toISOString()}, so this session's daily PnL is ` +
          `measured from it (${this.input.mode} mode; live would report unknown)`,
      });
    }

    if (!(openEquity > 0)) {
      return this.nonPositiveBase(key, openEquity);
    }

    return {
      known: true,
      open_equity: openEquity,
      realized_pnl: this.realizedFor(key, openAt),
    };
  }

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

function toFiniteNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return Number.NaN;

  const trimmed = raw.trim();
  if (trimmed === '') return Number.NaN;

  return Number(trimmed);
}
