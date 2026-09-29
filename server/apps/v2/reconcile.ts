import type {
  BookLedger,
  BookSpec,
  BrokerBook,
  BrokerBookReader,
  BrokerMode,
  BrokerOpenOrder,
  DecisionJournal,
  MarketData,
  OrderExecutor,
  ReconcileDiff,
  ReconcileSource,
  ReconcileStatus,
  SleeveSource,
  Venue,
} from '../../../contracts/index.js';
import type { Logger } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import { quotePerGbp } from './data/index.js';
import { type CashRule, compareVenue, type VenueView } from './reconcile-compare.js';

export interface ReconcileDeps {
  readonly registry: Pick<SleeveSource, 'ids'>;
  readonly books: Pick<BookLedger, 'forSleeve' | 'positions' | 'cash'>;
  readonly journal: Pick<DecisionJournal, 'restingEntries' | 'recordReconcile' | 'recordRefusal'>;
  readonly executor: Pick<OrderExecutor, 'simulates'>;
  readonly market: Pick<MarketData, 'gbpUsdAtYearStart'>;
  readonly brokerBooks: BrokerBookReader;
  readonly brokerMode: BrokerMode;
  readonly reconcileCashToleranceGbp: number | undefined;
  readonly logger?: Logger | undefined;
}

export interface ReconcileOutcome {
  readonly blockedBookIds: ReadonlySet<string>;
  readonly refusals: readonly string[];
}

interface VenueGroup {
  readonly venue: Venue;
  readonly source: ReconcileSource;
  readonly books: readonly BookSpec[];
}

const VENUE_SET: Readonly<Record<Venue, true>> = {
  alpaca: true,
  saxo: true,
  saxo_cfd_gbp: true,
  saxo_cfd_usd: true,
};
const VENUES = Object.keys(VENUE_SET) as Venue[];
const TICKET = '#1872';

function venueGroups(deps: ReconcileDeps): VenueGroup[] {
  const groups = new Map<string, { venue: Venue; source: ReconcileSource; books: BookSpec[] }>();
  for (const sleeveId of deps.registry.ids()) {
    for (const book of deps.books.forSleeve(sleeveId)) {
      for (const venue of VENUES) {
        const route = { bookVariant: book.variant, venue };
        const source: ReconcileSource = deps.executor.simulates(route) ? 'simulated' : 'broker';
        const key = `${venue}|${source}`;
        const group = groups.get(key) ?? { venue, source, books: [] };
        group.books.push(book);
        groups.set(key, group);
      }
    }
  }
  return [...groups.values()];
}

export function storeView(
  deps: Pick<ReconcileDeps, 'books' | 'journal'>,
  venue: Venue,
  books: readonly BookSpec[],
): VenueView {
  const positions = new Map<string, number>();
  const openOrders: BrokerOpenOrder[] = [];
  let cashGbp = 0;
  for (const book of books) {
    cashGbp += deps.books.cash(book.id);
    for (const held of deps.books.positions(book.id)) {
      if (held.venue !== venue) continue;
      positions.set(held.instrument, (positions.get(held.instrument) ?? 0) + held.qty);
    }
    for (const order of deps.journal.restingEntries(book.id)) {
      if (order.venue !== venue) continue;
      openOrders.push({ clientOrderId: order.client_order_id, instrument: order.instrument });
    }
  }
  return { positions, openOrders, cashGbp };
}

function brokerView(book: BrokerBook, quotePerGbpRate: number): VenueView {
  const positions = new Map<string, number>();
  for (const held of book.positions) {
    positions.set(held.instrument, (positions.get(held.instrument) ?? 0) + held.qty);
  }
  const cashGbp = book.cashQuote / quotePerGbpRate;
  if (!Number.isFinite(cashGbp)) throw new Error(`broker cash ${book.cashQuote} is not a number`);
  return { positions, openOrders: book.openOrders, cashGbp };
}

type Read =
  | { readonly ok: true; readonly view: VenueView }
  | { readonly ok: false; readonly error: string };

async function readBroker(deps: ReconcileDeps, venue: Venue, tradingDate: string): Promise<Read> {
  try {
    const book = await deps.brokerBooks.read(venue);
    return { ok: true, view: brokerView(book, quotePerGbp(deps.market, venue, tradingDate)) };
  } catch (error) {
    return { ok: false, error: describeThrownSafely(error) };
  }
}

function statusOf(diffs: readonly ReconcileDiff[]): ReconcileStatus {
  if (diffs.length === 0) return 'clean';
  return diffs.every((entry) => entry.kind === 'cash_unverified') ? 'unverified' : 'mismatch';
}

function describeDiff(entry: ReconcileDiff): string {
  const subject = entry.instrument ?? 'cash';
  const order = entry.order_id === null ? '' : ` ${entry.order_id}`;
  return `${entry.kind} ${subject}${order} store ${entry.store ?? '-'} broker ${entry.broker ?? '-'}`;
}

interface GroupResult {
  readonly status: ReconcileStatus;
  readonly diffs: readonly ReconcileDiff[];
  readonly detail: string;
}

// A simulated venue keeps no state outside the ledger: its fills are written straight into the
// books, so the ledger is the simulated book and comparing it with itself cannot differ
const SIMULATED_CLEAN: GroupResult = {
  status: 'clean',
  diffs: [],
  detail: 'simulated venue: the ledger is its book',
};

// David 2026-09-29 (#1872): paper compares positions and orders only; the cash check, and the
// unset tolerance that blocks entries, apply to live alone
const PAPER_CASH_NOT_COMPARED = 'cash not compared on paper (David 2026-09-29, #1872)';

function cashRuleFor(deps: ReconcileDeps): CashRule {
  if (deps.brokerMode === 'paper') return 'not_compared';
  return { toleranceGbp: deps.reconcileCashToleranceGbp };
}

async function reconcileGroup(
  deps: ReconcileDeps,
  group: VenueGroup,
  tradingDate: string,
): Promise<GroupResult> {
  if (group.source === 'simulated') return SIMULATED_CLEAN;
  const store = storeView(deps, group.venue, group.books);
  const read = await readBroker(deps, group.venue, tradingDate);
  if (!read.ok) return { status: 'read_failed', diffs: [], detail: read.error };
  const cash = cashRuleFor(deps);
  const diffs = compareVenue(store, read.view, cash);
  const notes = cash === 'not_compared' ? [PAPER_CASH_NOT_COMPARED] : [];
  return {
    status: statusOf(diffs),
    diffs,
    detail: [...diffs.map(describeDiff), ...notes].join('; '),
  };
}

const REFUSAL_PARAMETER: Readonly<Record<Exclude<ReconcileStatus, 'clean'>, string>> = {
  mismatch: 'BROKER_RECONCILE',
  unverified: 'RECONCILE_CASH_TOLERANCE_GBP',
  read_failed: 'BROKER_RECONCILE_READ',
};

const LOG_LEVEL: Readonly<Record<Exclude<ReconcileStatus, 'clean'>, 'error' | 'warn' | undefined>> =
  {
    mismatch: 'error',
    unverified: undefined,
    read_failed: 'warn',
  };

function blockGroup(
  deps: ReconcileDeps,
  group: VenueGroup,
  tradingDate: string,
  result: GroupResult & { status: Exclude<ReconcileStatus, 'clean'> },
): string[] {
  const summary = `${group.venue} ${group.source} reconcile ${result.status}: ${result.detail}`;
  const level = LOG_LEVEL[result.status];
  if (level !== undefined) {
    deps.logger?.log({
      trace_id: `v2-${tradingDate}`,
      stage: 'v2',
      level,
      event: `v2_reconcile_${result.status}`,
      message: summary,
      payload: result.diffs,
    });
  }
  return group.books.map((book) => {
    const message = `${book.id}: entries blocked, ${summary}`;
    deps.journal.recordRefusal({
      trading_date: tradingDate,
      scope: 'reconcile',
      parameter: REFUSAL_PARAMETER[result.status],
      ticket: TICKET,
      message,
      book_id: book.id,
    });
    return message;
  });
}

export async function reconcileBooks(
  deps: ReconcileDeps,
  tradingDate: string,
): Promise<ReconcileOutcome> {
  const blockedBookIds = new Set<string>();
  const refusals: string[] = [];
  for (const group of venueGroups(deps)) {
    const result = await reconcileGroup(deps, group, tradingDate);
    deps.journal.recordReconcile({
      trading_date: tradingDate,
      venue: group.venue,
      source: group.source,
      status: result.status,
      book_ids: group.books.map((book) => book.id),
      diffs: result.diffs,
      detail: result.detail,
    });
    if (result.status === 'clean') continue;
    refusals.push(...blockGroup(deps, group, tradingDate, { ...result, status: result.status }));
    for (const book of group.books) blockedBookIds.add(book.id);
  }
  return { blockedBookIds, refusals };
}
