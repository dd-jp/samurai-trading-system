import type { BookLedger, MarketData, Position, Venue } from '../../../contracts/index.js';
import {
  type CfdDividendBooking,
  type CfdDividendLedger,
  dividendWindow,
  heldDividends,
} from './cfd-dividends.js';
import { isCfdVenue } from './data/index.js';
import type { CfdDividendFeed, DividendRequest } from './dividend-feed.js';
import { exchangeOf } from './split-crosscheck.js';

export interface CfdDividendStepDeps {
  readonly books: Pick<BookLedger, 'positions' | 'lastDay' | 'applyCashAdjustment'>;
  readonly bookIds: readonly string[];
  readonly market: Pick<MarketData, 'lastBarBefore' | 'barsBefore'>;
  readonly feed: CfdDividendFeed | undefined;
  readonly ledger: CfdDividendLedger;
  readonly tradingDate: string;
  readonly fxFor: (venue: Venue) => number;
  readonly atomically: <T>(work: () => T) => T;
}

export interface UnbookedDividend {
  readonly bookId: string;
  readonly instrument: string;
  readonly detail: string;
}

export interface CfdDividendStepReport {
  readonly booked: readonly CfdDividendBooking[];
  readonly unread: readonly UnbookedDividend[];
  readonly splitBefore: readonly UnbookedDividend[];
  readonly unmodelled: readonly UnbookedDividend[];
}

interface HeldCfd {
  readonly bookId: string;
  readonly held: Position;
  readonly lastMarkDate: string | undefined;
}

function heldCfds(deps: CfdDividendStepDeps): HeldCfd[] {
  return deps.bookIds.flatMap((bookId) => {
    const lastMarkDate = deps.books.lastDay(bookId)?.tradingDate;
    return deps.books
      .positions(bookId)
      .filter((held) => isCfdVenue(held.venue))
      .map((held) => ({ bookId, held, lastMarkDate }));
  });
}

function requestsFor(deps: CfdDividendStepDeps, held: readonly HeldCfd[]): DividendRequest[] {
  return held.flatMap(({ held: position, lastMarkDate }) => {
    const window = dividendWindow({
      held: position,
      tradingDate: deps.tradingDate,
      lastMarkDate,
      market: deps.market,
    });
    if (window === undefined) return [];
    return [{ instrument: position.instrument, exchange: exchangeOf(position.venue), ...window }];
  });
}

function unbooked(position: HeldCfd, detail: string): UnbookedDividend {
  return { bookId: position.bookId, instrument: position.held.instrument, detail };
}

function book(deps: CfdDividendStepDeps, booking: CfdDividendBooking): void {
  deps.atomically(() => {
    deps.books.applyCashAdjustment(booking.book_id, booking.amount_gbp);
    deps.ledger.record(booking);
  });
}

interface StepReport {
  readonly booked: CfdDividendBooking[];
  readonly unread: UnbookedDividend[];
  readonly splitBefore: UnbookedDividend[];
}

function bookPosition(
  deps: CfdDividendStepDeps,
  feed: CfdDividendFeed,
  position: HeldCfd,
  report: StepReport,
): void {
  const result = heldDividends({
    ...position,
    tradingDate: deps.tradingDate,
    market: deps.market,
    source: feed,
    fxQuotePerGbp: deps.fxFor(position.held.venue),
    booked: (exDate) => deps.ledger.booked(position.bookId, position.held.instrument, exDate),
  });
  for (const booking of result.bookings) book(deps, booking);
  report.booked.push(...result.bookings);
  if (result.unread !== undefined) report.unread.push(unbooked(position, result.unread));
  if (result.splitBefore !== undefined) {
    report.splitBefore.push(unbooked(position, result.splitBefore));
  }
}

// Runs before the cycle books any fill, so each position is the holding at the last mark
export async function bookCfdDividends(deps: CfdDividendStepDeps): Promise<CfdDividendStepReport> {
  const held = heldCfds(deps);
  const report: StepReport = { booked: [], unread: [], splitBefore: [] };
  const { feed } = deps;
  if (feed === undefined) {
    return { ...report, unmodelled: held.map((position) => unbooked(position, 'no feed')) };
  }
  await feed.refresh(requestsFor(deps, held));
  for (const position of held) bookPosition(deps, feed, position, report);
  return { ...report, unmodelled: [] };
}
