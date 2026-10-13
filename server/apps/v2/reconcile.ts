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
  Position,
  ReconcileDiff,
  ReconcileSource,
  ReconcileStatus,
  SleeveSource,
  Venue,
} from '../../../contracts/index.js';
import type { Logger } from '../../shared/index.js';
import { describeThrownSafely, logIfPresent } from '../../shared/index.js';
import { type CashAnchorLedger, type CashCheck, liveCashCheck } from './cash-anchor.js';
import {
  compareVenue,
  type HeldProtection,
  protectingStops,
  rearmable,
  type StoreView,
  type VenueView,
} from './reconcile-compare.js';

export interface ReconcileDeps {
  readonly registry: Pick<SleeveSource, 'ids'>;
  readonly books: Pick<BookLedger, 'forSleeve' | 'positions'>;
  readonly journal: Pick<
    DecisionJournal,
    'restingEntries' | 'orderFor' | 'recordReconcile' | 'recordRefusal'
  >;
  readonly executor: Pick<OrderExecutor, 'simulates'>;
  readonly market: Pick<MarketData, 'gbpUsdOnDay'>;
  readonly brokerBooks: BrokerBookReader;
  readonly brokerMode: BrokerMode;
  readonly reconcileCashToleranceGbp: number | undefined;
  readonly cashAnchors?: CashAnchorLedger | undefined;
  readonly logger?: Logger | undefined;
}

export interface StaleStop {
  readonly venue: Venue;
  readonly instrument: string;
}

export interface ReconcileOutcome {
  readonly blockedBookIds: ReadonlySet<string>;
  readonly refusals: readonly string[];
  readonly staleStops?: readonly StaleStop[] | undefined;
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
const TICKET = '#1927';

function sourceOf(
  deps: Pick<ReconcileDeps, 'executor'>,
  book: BookSpec,
  venue: Venue,
): ReconcileSource {
  return deps.executor.simulates({ bookVariant: book.variant, venue }) ? 'simulated' : 'broker';
}

function addToGroup(
  groups: Map<string, { venue: Venue; source: ReconcileSource; books: BookSpec[] }>,
  venue: Venue,
  source: ReconcileSource,
  book: BookSpec,
): void {
  const key = `${venue}|${source}`;
  const group = groups.get(key) ?? { venue, source, books: [] };
  group.books.push(book);
  groups.set(key, group);
}

function allBooks(deps: Pick<ReconcileDeps, 'registry' | 'books'>): BookSpec[] {
  return deps.registry.ids().flatMap((sleeveId) => deps.books.forSleeve(sleeveId));
}

function venueGroups(deps: Pick<ReconcileDeps, 'registry' | 'books' | 'executor'>): VenueGroup[] {
  const groups = new Map<string, { venue: Venue; source: ReconcileSource; books: BookSpec[] }>();
  for (const book of allBooks(deps)) {
    for (const venue of VENUES) addToGroup(groups, venue, sourceOf(deps, book, venue), book);
  }
  return [...groups.values()];
}

function netByInstrument(
  held: readonly { readonly instrument: string; readonly qty: number }[],
): Map<string, number> {
  const positions = new Map<string, number>();
  for (const { instrument, qty } of held) {
    positions.set(instrument, (positions.get(instrument) ?? 0) + qty);
  }
  return positions;
}

// The entry's stop is journalled in the units it was priced in; the ledger's split factor carries
// it into the units the venue now quotes
function nativeStop(deps: Pick<ReconcileDeps, 'journal'>, held: Position): number[] {
  const stop = deps.journal.orderFor(held.clientOrderId)?.payload.stop;
  return typeof stop === 'number' ? [stop / held.splitFactor] : [];
}

function protectionByInstrument(
  deps: Pick<ReconcileDeps, 'journal'>,
  held: readonly Position[],
): Map<string, HeldProtection> {
  const protection = new Map<string, HeldProtection>();
  for (const position of held) {
    const known = protection.get(position.instrument) ?? { entryOrderIds: [], stops: [] };
    protection.set(position.instrument, {
      entryOrderIds: [...known.entryOrderIds, position.clientOrderId],
      stops: [...known.stops, ...nativeStop(deps, position)],
    });
  }
  return protection;
}

export function storeView(
  deps: Pick<ReconcileDeps, 'books' | 'journal'>,
  venue: Venue,
  books: readonly BookSpec[],
): StoreView {
  const held = books
    .flatMap((book) => deps.books.positions(book.id))
    .filter((position) => position.venue === venue);
  const resting = books
    .flatMap((book) => deps.journal.restingEntries(book.id))
    .filter((order) => order.venue === venue);
  return {
    positions: netByInstrument(held),
    openOrders: resting.map((order) => ({
      clientOrderId: order.client_order_id,
      instrument: order.instrument,
      protects: null,
      qty: null,
      stopPrice: null,
    })),
    protection: protectionByInstrument(deps, held),
  };
}

function brokerView(book: BrokerBook): VenueView {
  if (!Number.isFinite(book.cashQuote)) {
    throw new Error(`broker cash ${book.cashQuote} is not a number`);
  }
  return { positions: netByInstrument(book.positions), openOrders: book.openOrders };
}

type Read =
  | { readonly ok: true; readonly view: VenueView; readonly cashQuote: number }
  | { readonly ok: false; readonly error: string };

async function readBroker(deps: ReconcileDeps, venue: Venue): Promise<Read> {
  try {
    const book = await deps.brokerBooks.read(venue);
    return { ok: true, view: brokerView(book), cashQuote: book.cashQuote };
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
  readonly cashQuote?: number;
  readonly staleStops?: readonly StaleStop[];
  readonly protectingStops?: readonly BrokerOpenOrder[];
}

// A simulated venue keeps no state outside the ledger: its fills are written straight into the
// books, so the ledger is the simulated book and comparing it with itself cannot differ
const SIMULATED_CLEAN: GroupResult = {
  status: 'clean',
  diffs: [],
  detail: 'simulated venue: the ledger is its book',
};

// David 2026-09-29 (#1872): paper compares positions and orders only; the cash check applies to
// live alone
const PAPER_CASH_NOT_COMPARED = 'cash not compared on paper (David 2026-09-29, #1872)';

function cashCheckFor(
  deps: ReconcileDeps,
  venue: Venue,
  read: { readonly cashQuote: number; readonly booksMatch: boolean },
  tradingDate: string,
): CashCheck {
  if (deps.brokerMode === 'paper') return { diffs: [], note: PAPER_CASH_NOT_COMPARED };
  return liveCashCheck(deps, { venue, ...read }, tradingDate);
}

function staleStopsOf(
  venue: Venue,
  diffs: readonly ReconcileDiff[],
  rearm: (instrument: string) => boolean,
): StaleStop[] {
  const instruments = diffs
    .filter(
      (entry) =>
        entry.kind === 'protective_qty' ||
        entry.kind === 'protective_price' ||
        (entry.kind === 'position_unprotected' && rearm(entry.instrument as string)),
    )
    .map((entry) => entry.instrument as string);
  return [...new Set(instruments)].map((instrument) => ({ venue, instrument }));
}

async function reconcileGroup(
  deps: ReconcileDeps,
  group: VenueGroup,
  tradingDate: string,
): Promise<GroupResult> {
  if (group.source === 'simulated') return SIMULATED_CLEAN;
  const store = storeView(deps, group.venue, group.books);
  const read = await readBroker(deps, group.venue);
  if (!read.ok) return { status: 'read_failed', diffs: [], detail: read.error };
  const bookDiffs = compareVenue(store, read.view);
  const cash = cashCheckFor(
    deps,
    group.venue,
    { cashQuote: read.cashQuote, booksMatch: bookDiffs.length === 0 },
    tradingDate,
  );
  const diffs = [...bookDiffs, ...cash.diffs];
  return {
    status: statusOf(diffs),
    diffs,
    detail: [...diffs.map(describeDiff), cash.note].join('; '),
    cashQuote: read.cashQuote,
    staleStops: staleStopsOf(group.venue, bookDiffs, rearmable(store, read.view)),
    protectingStops: protectingStops(store, read.view),
  };
}

const REFUSAL_PARAMETER: Readonly<Record<Exclude<ReconcileStatus, 'clean'>, string>> = {
  mismatch: 'BROKER_RECONCILE',
  unverified: 'RECONCILE_CASH_TOLERANCE_GBP',
  read_failed: 'BROKER_RECONCILE_READ',
};

const ALERT: Readonly<
  Record<
    Exclude<ReconcileStatus, 'clean'>,
    { readonly level: 'error' | 'warn'; readonly event: string } | undefined
  >
> = {
  mismatch: { level: 'error', event: 'v2_reconcile_mismatch' },
  unverified: undefined,
  read_failed: { level: 'warn', event: 'v2_reconcile_read_failed' },
};

function blockGroup(
  deps: ReconcileDeps,
  group: VenueGroup,
  tradingDate: string,
  result: GroupResult & { status: Exclude<ReconcileStatus, 'clean'> },
): string[] {
  const summary = `${group.venue} ${group.source} reconcile ${result.status}: ${result.detail}`;
  const alert = ALERT[result.status];
  if (alert !== undefined) {
    deps.logger?.log({
      trace_id: `v2-${tradingDate}`,
      stage: 'v2',
      ...alert,
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
  const staleStops: StaleStop[] = [];
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
      broker_mode: deps.brokerMode,
      cash_quote: result.cashQuote ?? null,
      protecting_stops: result.protectingStops,
    });
    if (result.status === 'clean') continue;
    refusals.push(...blockGroup(deps, group, tradingDate, { ...result, status: result.status }));
    for (const book of group.books) blockedBookIds.add(book.id);
    staleStops.push(...(result.staleStops ?? []));
  }
  return { blockedBookIds, refusals, staleStops };
}

export type SyncThrowEvent =
  | 'v2_pending_resolve_threw'
  | 'v2_fill_sweep_threw'
  | 'v2_split_rescale_threw'
  | 'v2_entry_cancel_threw'
  | 'v2_reconcile_threw';

export interface ThrowFailure {
  readonly event: SyncThrowEvent;
  readonly what: string;
}

export interface StepThrow {
  readonly failure: ThrowFailure;
  readonly error: unknown;
}

type ThrowDeps = Pick<
  ReconcileDeps,
  'registry' | 'books' | 'executor' | 'journal' | 'logger' | 'brokerMode'
>;

// The signals entry pass gates on the latest journalled reconcile for the date, so a throw must
// supersede an earlier clean row from a same-date retry. Best effort: the journal may be the
// store that threw
function journalThrow(deps: ThrowDeps, tradingDate: string, summary: string): void {
  try {
    for (const group of venueGroups(deps)) {
      deps.journal.recordReconcile({
        trading_date: tradingDate,
        venue: group.venue,
        source: group.source,
        status: 'read_failed',
        book_ids: group.books.map((book) => book.id),
        diffs: [],
        detail: summary,
        broker_mode: deps.brokerMode,
        cash_quote: null,
      });
    }
  } catch {
    return;
  }
}

// A throw in a step before reconcile, or in reconcile, blocks entries and must never skip the
// exits and resting stops after it (postmortem §3, #1927); a throwing logger must not escape either
export function blockEntriesOnThrow(
  deps: ThrowDeps,
  tradingDate: string,
  failure: ThrowFailure,
  error: unknown,
): ReconcileOutcome {
  return blockEntriesOnThrows(deps, tradingDate, [{ failure, error }]);
}

export function blockEntriesOnThrows(
  deps: ThrowDeps,
  tradingDate: string,
  thrown: readonly StepThrow[],
): ReconcileOutcome {
  const summaries = thrown.map(({ failure: { event, what }, error }) => {
    const message = `${what} threw: ${describeThrownSafely(error)}`;
    logIfPresent(deps.logger, {
      trace_id: `v2-${tradingDate}`,
      stage: 'v2',
      level: 'error',
      event,
      message,
    });
    return message;
  });
  const summary = summaries.join('; ');
  journalThrow(deps, tradingDate, summary);
  const bookIds = allBooks(deps).map((book) => book.id);
  return {
    blockedBookIds: new Set(bookIds),
    refusals: bookIds.map((bookId) => `${bookId}: entries blocked, ${summary}`),
  };
}

export async function reconcileOrBlockEntries(
  deps: ReconcileDeps,
  tradingDate: string,
): Promise<ReconcileOutcome> {
  try {
    return await reconcileBooks(deps, tradingDate);
  } catch (error) {
    return blockEntriesOnThrow(
      deps,
      tradingDate,
      { event: 'v2_reconcile_threw', what: 'reconcile' },
      error,
    );
  }
}
