import type { BookLedger, MarketData } from '../../../contracts/index.js';
import {
  type CfdDividendBooking,
  type CfdDividendLedger,
  type CfdFillSource,
  type DividendSubject,
  dividendWindow,
  type HeldDividends,
  heldDividends,
  type SessionFill,
} from './cfd-dividends.js';
import { type ConvertibleCurrency, isCfdVenue } from './data/index.js';
import type { CfdDividendFeed, DividendRequest } from './dividend-feed.js';
import { exchangeOf } from './split-crosscheck.js';

export interface CfdDividendStepDeps {
  readonly books: Pick<BookLedger, 'positions' | 'lastDay' | 'applyCashAdjustment'>;
  readonly bookIds: readonly string[];
  readonly market: Pick<MarketData, 'lastBarBefore' | 'barsBefore'>;
  readonly feed: CfdDividendFeed | undefined;
  readonly ledger: CfdDividendLedger;
  readonly fills: CfdFillSource;
  readonly tradingDate: string;
  readonly fxFor: (currency: ConvertibleCurrency) => number;
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
  readonly refused: readonly UnbookedDividend[];
  readonly implausible: readonly UnbookedDividend[];
  readonly unverifiable: readonly UnbookedDividend[];
  readonly unmodelled: readonly UnbookedDividend[];
}

interface HeldCfd {
  readonly bookId: string;
  readonly subject: DividendSubject;
  readonly fills: readonly SessionFill[];
  readonly lastMarkDate: string | undefined;
}

function subjectsOf(
  deps: CfdDividendStepDeps,
  bookId: string,
  lastMarked: string | undefined,
): DividendSubject[] {
  const open: DividendSubject[] = deps.books
    .positions(bookId)
    .filter((position) => isCfdVenue(position.venue))
    .map((position) => ({ instrument: position.instrument, venue: position.venue, position }));
  if (lastMarked === undefined) return open;
  const closed: DividendSubject[] = deps.fills
    .cfdInstrumentsFilledAfter(bookId, lastMarked)
    .filter(({ instrument }) => !open.some((subject) => subject.instrument === instrument))
    .map(({ instrument, venue }) => ({ instrument, venue, position: undefined }));
  return [...open, ...closed];
}

function heldAtMark(deps: CfdDividendStepDeps, held: HeldCfd): boolean {
  const lastMarkDate = held.lastMarkDate as string;
  if ((held.subject.position?.openedDate ?? '9999') <= lastMarkDate) return true;
  const window = dividendWindow({
    subject: held.subject,
    tradingDate: deps.tradingDate,
    lastMarkDate,
    market: deps.market,
  });
  const through = window?.through ?? lastMarkDate;
  return held.fills.some((fill) => (fill.session ?? fill.trading_date) < through);
}

// A CFD closed since the last mark was held at the close of an ex-date inside the window, so it
// is read as well as the ones still open; one first filled on or after the bar marked now was held
// at none (a position the journal holds no fill for is read from its opening date)
function heldCfds(deps: CfdDividendStepDeps): HeldCfd[] {
  return deps.bookIds.flatMap((bookId) => {
    const lastMarked = deps.books.lastDay(bookId)?.tradingDate;
    return subjectsOf(deps, bookId, lastMarked)
      .map((subject) => ({
        bookId,
        subject,
        lastMarkDate: lastMarked ?? subject.position?.openedDate,
        fills: deps.fills.fillsFor(bookId, subject.instrument),
      }))
      .filter((held) => held.lastMarkDate !== undefined && heldAtMark(deps, held));
  });
}

function requestsFor(deps: CfdDividendStepDeps, held: readonly HeldCfd[]): DividendRequest[] {
  return held.flatMap(({ subject, lastMarkDate }) => {
    const window = dividendWindow({
      subject,
      tradingDate: deps.tradingDate,
      lastMarkDate,
      market: deps.market,
    });
    if (window === undefined) return [];
    return [{ instrument: subject.instrument, exchange: exchangeOf(subject.venue), ...window }];
  });
}

function unbooked(position: HeldCfd, detail: string): UnbookedDividend {
  return { bookId: position.bookId, instrument: position.subject.instrument, detail };
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
  readonly refused: UnbookedDividend[];
  readonly implausible: UnbookedDividend[];
  readonly unverifiable: UnbookedDividend[];
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
    fxFor: deps.fxFor,
    booked: (exDate) => deps.ledger.booked(position.bookId, position.subject.instrument, exDate),
  });
  for (const booking of result.bookings) book(deps, booking);
  report.booked.push(...result.bookings);
  reportUnbooked(result, position, report);
}

const LISTED_UNBOOKED = ['refused', 'implausible', 'unverifiable'] as const;

function reportUnbooked(result: HeldDividends, position: HeldCfd, report: StepReport): void {
  if (result.unread !== undefined) report.unread.push(unbooked(position, result.unread));
  if (result.splitBefore !== undefined) {
    report.splitBefore.push(unbooked(position, result.splitBefore));
  }
  for (const kind of LISTED_UNBOOKED) {
    for (const detail of result[kind] ?? []) report[kind].push(unbooked(position, detail));
  }
}

// Runs after the cycle books its fills (#2171): each ex-date's holding is rebuilt from the ledger and the journalled fills
export async function bookCfdDividends(deps: CfdDividendStepDeps): Promise<CfdDividendStepReport> {
  const held = heldCfds(deps);
  const report: StepReport = {
    booked: [],
    unread: [],
    splitBefore: [],
    refused: [],
    implausible: [],
    unverifiable: [],
  };
  const { feed } = deps;
  if (feed === undefined) {
    return { ...report, unmodelled: held.map((position) => unbooked(position, 'no feed')) };
  }
  await feed.refresh(requestsFor(deps, held));
  for (const position of held) bookPosition(deps, feed, position, report);
  return { ...report, unmodelled: [] };
}
