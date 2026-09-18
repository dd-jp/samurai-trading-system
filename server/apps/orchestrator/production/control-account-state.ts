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

const EPOCH = new Date(0);

export interface ControlArmAccountStateProviderInput {
  resolveBook: (asOf: Date) => Promise<number>;
  closedTrades: ClosedTradeReader;
  getOpenPositions: () => Promise<readonly OpenPosition[]>;
  calendars: { crypto: TradingCalendar; stocks: TradingCalendar };
  lossStreakWindowDays?: number;
}

export class ControlArmAccountStateProvider implements AccountStateProvider {
  #book: number | null = null;

  constructor(private readonly input: ControlArmAccountStateProviderInput) {}

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
    const book = await this.book(asOf);
    const trades = this.input.closedTrades.getClosedTradesBetween(EPOCH, asOf);
    const positions = await this.input.getOpenPositions();

    const realized = trades.reduce((total, trade) => total + trade.realized_pnl_net, 0);
    const equityAtCost = book + realized;

    return {
      cash: equityAtCost - deployedCash(positions),
      peak_equity: realizedHighWaterMark(trades, book),
      daily_basis: {
        crypto: this.sessionBasisFor('crypto', trades, asOf, book),
        stocks: this.sessionBasisFor('stocks', trades, asOf, book),
        portfolio: this.sessionBasisFor('portfolio', trades, asOf, book),
      },
      consecutive_losses: this.consecutiveLosses(trades, asOf),
    };
  }

  private calendarFor(key: SessionEquityKey): TradingCalendar {
    return key === 'stocks' ? this.input.calendars.stocks : this.input.calendars.crypto;
  }

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
        if (key === 'portfolio' || trade.asset_class === key) {
          realizedSince += trade.realized_pnl_net;
        }
      } else {
        realizedBefore += trade.realized_pnl_net;
      }
    }

    const openEquity = book + realizedBefore;
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

interface BookAnchorStore {
  peakEquity(): number | null;
  anchorEquity(equity: number, asOf: Date): number;
}

export interface ControlBookAnchorResolverInput {
  liveAccountState: AccountStateProvider;
  store: BookAnchorStore;
  fallbackBook: number;
  liveBookCeiling?: RiskConfig['live_book_ceiling'];
}

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
      return input.fallbackBook;
    }

    const ceiling = input.liveBookCeiling;
    if (ceiling !== undefined && ceiling.same_currency_verified === true) {
      observed = Math.min(observed, ceiling.book);
    }

    if (!(Number.isFinite(observed) && observed > 0)) {
      return input.fallbackBook;
    }

    return input.store.anchorEquity(observed, asOf);
  };
}

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
