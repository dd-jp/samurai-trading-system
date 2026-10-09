import { randomUUID } from 'node:crypto';
import type {
  BookDay,
  BookLedger,
  BookSpec,
  BrokerBookReader,
  BrokerCashActivityReader,
  BrokerMode,
  ControlReader,
  DecisionJournal,
  EntryApproval,
  EntryQuote,
  EntryRoom,
  ExecutionRoute,
  JournalledOrder,
  JournalledOutcome,
  LossBudgetState,
  ManualControl,
  MarketData,
  OrderExecutor,
  OrderOutcome,
  OrderSide,
  Position,
  PositionLevels,
  RearmPrices,
  RescaleSource,
  RiskApprovedOrder,
  RiskGate,
  SimulatedFillQuote,
  SimulatedFillRequest,
  Sleeve,
  SleeveDecision,
  SleeveOutput,
  SleeveSource,
  Submission,
  V2Bar,
  V2Fill,
  Venue,
} from '../../../contracts/index.js';
import { CfdCostModelUnsetError } from '../../../contracts/index.js';
import type { Clock, Logger } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import { readBrokerCashActivities } from './cash-activities.js';
import type { CashAnchorLedger } from './cash-anchor.js';
import { cumulativeIncrement, type FillIncrement, wholeFill } from './cumulative-fill.js';
import {
  CALENDAR_REFERENCE,
  fillFxOf,
  isFresh,
  londonDateOf,
  MAX_BAR_AGE_CALENDAR_DAYS,
  type MacroGateVerdict,
  macroGate,
  quotePerGbp,
  type SitOutCode,
  type VenueSessionGate,
} from './data/index.js';
import {
  blockEntriesOnThrow,
  blockEntriesOnThrows,
  type ReconcileOutcome,
  reconcileOrBlockEntries,
  type StaleStop,
  type StepThrow,
  type ThrowFailure,
} from './reconcile.js';
import { CYCLE_LEVEL_PARAMETERS, isSet, UnsetParameterError } from './signal/index.js';
import {
  bracketExit,
  type LimitEntryOutcome,
  simulateLimitEntry,
  simulateMarketExit,
  withinLimit,
} from './simulated-entry.js';
import {
  cumulativeSplitRatios,
  fractionalShares,
  type SplitReading,
  splitRatioAcross,
} from './split.js';

interface CashInLieu {
  readonly fraction: number;
  readonly priceGbp: number;
  readonly anchorDate: string;
  readonly disposalDate: string;
  readonly sourceOrderId: string;
}

export interface CycleDeps {
  readonly registry: SleeveSource;
  readonly books: BookLedger;
  readonly journal: DecisionJournal;
  readonly risk: RiskGate;
  readonly executor: OrderExecutor;
  readonly brokerBooks: BrokerBookReader;
  readonly brokerMode: BrokerMode;
  readonly reconcileCashToleranceGbp: number | undefined;
  readonly cashAnchors?: CashAnchorLedger | undefined;
  readonly cashActivities?: BrokerCashActivityReader | undefined;
  readonly controls: ControlReader;
  readonly market: MarketData;
  readonly clock: Clock;
  readonly dryRun: boolean;
  readonly logger?: Logger | undefined;
  // Backtest only: forward paper must read a stale series as a data outage (#1804), never a delisting
  readonly closeEndedSeries?: boolean;
  readonly venueSessions?: VenueSessionGate | undefined;
  readonly runStartedAt?: Date | undefined;
  readonly atomically?: (<T>(work: () => T) => T) | undefined;
}

export interface BookReport {
  readonly book_id: string;
  readonly equity_gbp: number;
  readonly cash_gbp: number;
  readonly size_multiplier: number;
  readonly positions: number;
}

export interface CycleReport {
  readonly trading_date: string;
  readonly dry_run: boolean;
  readonly skipped: boolean;
  readonly macro: MacroGateVerdict;
  readonly sleeves: readonly string[];
  readonly decisions: number;
  readonly entries: number;
  readonly exits: number;
  readonly fills: number;
  readonly submitted_orders: number;
  readonly simulated_orders: number;
  readonly dry_run_refusals: number;
  readonly rejected_orders: number;
  readonly refusals: readonly string[];
  readonly books: readonly BookReport[];
}

const MS_PER_DAY = 86_400_000;
const MAX_PENDING_CALENDAR_DAYS = 5;
const EPOCH_ISO = new Date(0).toISOString();

export function calendarDaysBetween(from: string | undefined, to: string): number {
  if (from === undefined) return 0;
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY));
}

function isEntryAction(decision: SleeveDecision): boolean {
  return decision.action === 'enter_long' || decision.action === 'enter_short';
}

function opposite(side: OrderSide): OrderSide {
  return side === 'buy' ? 'sell' : 'buy';
}

// A stop/target/exit fill closes a bracket entry's other leg; its levels describe the
// position being closed, not whatever this fill leaves behind, so they never carry (#1778)
function bracketLevelsGbp(
  fill: V2Fill,
  order: JournalledOrder,
  fx: number,
): { stopGbp: number | undefined; targetGbp: number | undefined } {
  if (fill.leg !== 'entry') return { stopGbp: undefined, targetGbp: undefined };
  const { stop, target } = order.payload;
  return {
    stopGbp: typeof stop === 'number' ? stop / fx : undefined,
    targetGbp: typeof target === 'number' ? target / fx : undefined,
  };
}

function levelsOf(held: Position): PositionLevels {
  return {
    qty: held.qty,
    avgPriceGbp: held.avgPriceGbp,
    stopGbp: held.stopGbp,
    targetGbp: held.targetGbp,
  };
}

function routeOf(book: BookSpec, venue: Venue) {
  return { bookVariant: book.variant, venue };
}

export function vetoApplied(book: BookSpec, decision: SleeveDecision): SleeveDecision {
  if (decision.veto === undefined || book.variant === 'no-veto') return decision;
  if (decision.action !== 'enter_long' && decision.action !== 'enter_short') return decision;
  return { ...decision, action: 'skip', reason: `vetoed: ${decision.veto}` };
}

interface Tally {
  submitted: number;
  simulated: number;
  refused: number;
  rejected: number;
  entries: number;
  exits: number;
  fills: number;
}

type PartFillProtection = 'rearm' | 'exit';

type ExitReason =
  | 'time_stop'
  | 'manual_halt'
  | 'crossing_fill'
  | 'signal_exit'
  | 'stop_replace_failed';

const BPS = 10_000;
const CONTROL_TICKET = 'docs/specs/dashboard-spec.md §5';

function positionKey(bookId: string, instrument: string): string {
  return `${bookId}|${instrument}`;
}

function approvedLimit(approval: EntryApproval): number | undefined {
  return approval.order?.kind === 'bracket_entry' ? approval.order.entry : undefined;
}

// Entries journalled before #1815 carry no limit: they went out at the decision price
function journalledLimit(order: JournalledOrder): number | undefined {
  return numberOrUndefined(order.payload.limit) ?? numberOrUndefined(order.payload.price);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function journalledQuoteFill(payload: Record<string, unknown>): number | null | undefined {
  const quote = payload.entry_quote as EntryQuote | undefined;
  return quote?.fill;
}

function nativeRearmPrices(journal: DecisionJournal, held: Position): RearmPrices | undefined {
  const entry = journal.orderFor(held.clientOrderId);
  const stop = entry === undefined ? undefined : numberOrUndefined(entry.payload.stop);
  const target = entry === undefined ? undefined : numberOrUndefined(entry.payload.target);
  if (stop === undefined || target === undefined) return undefined;
  return { stop: stop / held.splitFactor, target: target / held.splitFactor };
}

const SIMULATED_OUTCOMES: ReadonlySet<OrderOutcome> = new Set(['simulated', 'refused_dry_run']);

interface PendingResolution {
  readonly outcome: 'submitted' | 'rejected';
  readonly detail: string;
  readonly note: string;
}

export type EntryOrderId = (book: BookSpec, instrument: string, tradingDate: string) => string;

function defaultEntryOrderId(book: BookSpec, instrument: string, tradingDate: string): string {
  return `v2-${book.id.replaceAll('/', '-')}-${tradingDate}-${instrument}`;
}

const MAX_RESTOP_ATTEMPTS = 4;

function restopId(base: string, attempt: number): string {
  return attempt === 0 ? base : `${base}-${attempt + 1}`;
}

// A same-date re-run that still finds the stop stale or missing tries again under the next id: a
// cancel that timed out may complete late, and a refused flatten leaves the holding with no stop;
// an accepted flatten marks the exit pending, which keeps the holding out of here. The bound stops
// a reconcile that keeps disagreeing from churning the venue's stop
function nextRestopId(journal: Pick<DecisionJournal, 'orderFor'>, base: string): string | null {
  for (let attempt = 0; attempt < MAX_RESTOP_ATTEMPTS; attempt += 1) {
    const id = restopId(base, attempt);
    if (journal.orderFor(id) === undefined) return id;
  }
  return null;
}

function stopReplacedMessage(detail: string): string {
  return detail === 'closed'
    ? 'any stale stop cancelled, nothing placed: the broker holds none of it on that side; reconcile names the difference'
    : "any stale stop cancelled, stop placed for the ledger qty or the broker's if less";
}

function stopReplaceRefusal(step: 'cancel' | undefined): readonly [string, string] {
  return step === 'cancel'
    ? ['v2_stop_cancel_failed', 'the stale stop did not cancel, nothing placed']
    : ['v2_stop_replace_refused', 'the stop replace was refused before any cancel was sent'];
}

// A stray has no entry stop to re-place at, and a pending exit has already cancelled the legs
export function stopReplaceable(held: Position | undefined, venue: Venue): held is Position {
  return held?.venue === venue && !held.stray && held.exitClientOrderId === undefined;
}

class Cycle {
  readonly runId = randomUUID();
  readonly refusals: string[] = [];
  readonly #pendingEntries = new Set<string>();
  readonly #entriesBlocked = new Set<string>();
  readonly #unrescaled = new Set<string>();
  readonly #unrescaledBooks = new Set<string>();
  readonly tally: Tally = {
    submitted: 0,
    simulated: 0,
    refused: 0,
    rejected: 0,
    entries: 0,
    exits: 0,
    fills: 0,
  };

  constructor(
    private readonly deps: CycleDeps,
    private readonly tradingDate: string,
    private readonly macro: MacroGateVerdict,
    private readonly control: ManualControl,
    private readonly entryOrderIdFor: EntryOrderId = defaultEntryOrderId,
    private readonly runStartedAt: Date = deps.runStartedAt ?? deps.clock.now(),
  ) {}

  fxFor(venue: Venue): number {
    return quotePerGbp(this.deps.market, venue, this.tradingDate);
  }

  markGbp(instrument: string, venue: Venue): number | undefined {
    const bar = this.deps.market.lastBarBefore(instrument, this.tradingDate);
    return bar === undefined ? undefined : bar.rawClose / this.fxFor(venue);
  }

  async sweepFills(): Promise<void> {
    const firstFillSeq = this.deps.journal.lastFillSeq();
    try {
      const sweep = await this.deps.executor.fetchNewFills(this.since());
      for (const failure of sweep.failures) this.log('warn', 'v2_fill_sweep_failed', failure);
      for (const fill of sweep.fills) this.ingest(fill);
    } finally {
      this.deps.journal.recordFillSweep(this.runId, this.tradingDate, firstFillSeq);
    }
  }

  since(): string {
    let earliest: string | undefined;
    for (const bookId of this.deps.books.ids()) {
      const recordedAt = this.deps.books.lastDay(bookId)?.recordedAt;
      if (recordedAt !== undefined && (earliest === undefined || recordedAt < earliest)) {
        earliest = recordedAt;
      }
    }
    return earliest === undefined ? EPOCH_ISO : new Date(earliest).toISOString();
  }

  ingest(fill: V2Fill): void {
    const order = this.deps.journal.orderFor(fill.client_order_id);
    if (order === undefined) {
      this.log('warn', 'v2_fill_unmatched', `fill ${fill.broker_fill_id} matches no v2 order`);
      return;
    }
    this.rescaleHeldToFill(order, fill);
    const baseFillId = `${order.venue}:${fill.broker_fill_id}`;
    const increment = this.incrementOf(order, fill, baseFillId);
    if (increment === undefined) return;
    const side = fill.leg === 'entry' || order.leg === 'exit' ? order.side : opposite(order.side);
    const fillFx = fillFxOf(this.deps.market, order.venue as Venue, this.tradingDate);
    const fx = fillFx.quotePerGbp;
    const priceGbp = increment.price / fx;
    const recorded = this.deps.journal.recordFill({
      fill_id: `${baseFillId}${increment.idSuffix}`,
      client_order_id: order.client_order_id,
      book_id: order.book_id,
      trading_date: this.tradingDate,
      instrument: order.instrument,
      venue: order.venue,
      leg: fill.leg,
      side,
      qty: increment.qty,
      price_gbp: priceGbp,
      fee_gbp: increment.fee / fx,
      currency: fillFx.currency,
      price_native: increment.price,
      fee_native: increment.fee,
      fx_quote_per_gbp: fx,
      fx_source: fillFx.source,
      fill_date: fill.filled_at === undefined ? null : londonDateOf(fill.filled_at),
      filled_at: fill.filled_at,
      broker_mode: this.deps.brokerMode,
    });
    if (!recorded) return;
    this.tally.fills += 1;
    const { stopGbp, targetGbp } = bracketLevelsGbp(fill, order, fx);
    const before = this.deps.books.position(order.book_id, order.instrument);
    const after = this.deps.books.applyFill(order.book_id, {
      instrument: order.instrument,
      venue: order.venue as Venue,
      side,
      leg: fill.leg,
      qty: increment.qty,
      priceGbp,
      feeGbp: increment.fee / fx,
      clientOrderId: order.client_order_id,
      tradingDate: this.tradingDate,
      stopGbp,
      targetGbp,
    });
    this.warnIfFillCrossedFlat(order, fill.leg, before, after);
    this.anchorOpeningFill(order, fill, before, after);
  }

  fillDate(fill: V2Fill): string | undefined {
    const date = fill.filled_at?.slice(0, 10);
    return date !== undefined && date < this.tradingDate ? date : undefined;
  }

  anchorOpeningFill(
    order: JournalledOrder,
    fill: V2Fill,
    before: Position | undefined,
    after: Position | undefined,
  ): void {
    const date = this.fillDate(fill);
    if (before !== undefined || after === undefined || fill.leg !== 'entry' || date === undefined) {
      return;
    }
    this.atomically(() => this.rescaleHeld(order.book_id, order.instrument, 1, date, 'anchor'));
  }

  brokerHeld(order: JournalledOrder): Position | undefined {
    const held = this.deps.books.position(order.book_id, order.instrument);
    if (held === undefined) return undefined;
    const book = this.bookSpec(order.book_id);
    if (book === undefined || this.deps.executor.simulates(routeOf(book, held.venue))) {
      return undefined;
    }
    return held;
  }

  bookSpec(bookId: string): BookSpec | undefined {
    return [...this.deps.registry.ids()]
      .flatMap((sleeveId) => this.deps.books.forSleeve(sleeveId))
      .find((spec) => spec.id === bookId);
  }

  // A pending order outlived the run that journalled it: the venue is asked by its client order
  // id, and one it never received was a missed entry, not an open one (David 2026-10-04, #1747)
  async resolvePendingOrders(): Promise<void> {
    for (const order of this.deps.journal.pendingOrders()) {
      const book = this.bookSpec(order.book_id);
      if (book !== undefined) await this.resolvePending(book, order);
    }
  }

  async resolvePending(book: BookSpec, order: JournalledOrder): Promise<void> {
    const resolution: PendingResolution = (await this.reachedVenue(book, order))
      ? { outcome: 'submitted', detail: 'submitted', note: 'the venue holds it, now submitted' }
      : {
          outcome: 'rejected',
          detail: 'not_sent: no order at the venue under this id',
          note: 'the venue never received it, now rejected',
        };
    this.deps.journal.resolvePending(
      order.client_order_id,
      resolution.outcome,
      resolution.detail,
      this.tradingDate,
    );
    this.log(
      'error',
      'v2_pending_order_resolved',
      `${order.client_order_id}: journalled pending by a run that ended before its outcome; ${resolution.note}`,
    );
  }

  // A broker route with no adapter this run cannot say whether it holds the order, and calling it
  // unsent would orphan an order the venue may hold
  async reachedVenue(book: BookSpec, order: JournalledOrder): Promise<boolean> {
    const route = routeOf(book, order.venue as Venue);
    if (!this.deps.executor.simulates(route) && !this.deps.executor.canRoute(route)) {
      throw new Error(`${order.client_order_id}: no broker for ${order.venue} to ask`);
    }
    const filled = await this.deps.executor.filledQty(
      route,
      order.client_order_id,
      order.instrument,
    );
    return filled !== undefined;
  }

  // The broker reports a fill in the units of its own day. The ledger position is rescaled to
  // them before the fill books, so a re-reported cumulative fill finds the same units booked
  // (the parts hold the broker's quantity) instead of a converted figure it cannot match
  rescaleHeldToFill(order: JournalledOrder, fill: V2Fill): void {
    if (fill.leg === 'entry') return;
    const held = this.brokerHeld(order);
    if (held === undefined) return;
    const date = this.fillDate(fill);
    if (date === undefined) {
      this.warnUndatedFill(order, fill);
      return;
    }
    const reading = this.splitBefore(held, date);
    if (reading.ratio === 1) return;
    const london = londonDateOf(fill.filled_at as string);
    const qty = this.splitHeld(order.book_id, held, reading, 'broker', date, london);
    this.alertBrokerSplit(order.book_id, held, reading.ratio, qty);
    this.log(
      'warn',
      'v2_fill_post_split_rescaled',
      `${order.book_id} ${order.instrument}: fill ${fill.broker_fill_id} is in units after a x${reading.ratio} split; ledger qty ${held.qty} -> ${qty} before it books`,
    );
  }

  warnUndatedFill(order: JournalledOrder, fill: V2Fill): void {
    if (fill.filled_at !== undefined) return;
    this.log(
      'warn',
      'v2_fill_undated',
      `${order.book_id} ${order.instrument}: broker fill ${fill.broker_fill_id} carries no fill time; a split before it cannot be placed`,
    );
  }

  splitBefore(held: Position, fillDate: string): SplitReading {
    const anchorDate =
      held.splitAnchorDate ??
      this.deps.market.lastBarBefore(held.instrument, held.openedDate)?.date;
    if (anchorDate === undefined) return splitRatioAcross([]);
    const days = calendarDaysBetween(anchorDate, this.tradingDate);
    const bars = this.deps.market
      .barsBefore(held.instrument, this.tradingDate, days)
      .filter((dated) => dated.date >= anchorDate && dated.date <= fillDate);
    return splitRatioAcross(bars);
  }

  // Alpaca re-reports each order's running filled_qty and average price under one order id
  // (#1873); only the part beyond what the journal already holds for that id is a new fill
  incrementOf(order: JournalledOrder, fill: V2Fill, baseFillId: string): FillIncrement | undefined {
    if (fill.qty_is_cumulative !== true) return wholeFill(fill);
    const venue = order.venue as Venue;
    const verdict = cumulativeIncrement(this.deps.journal.fillPartsOf(baseFillId), fill, (date) =>
      quotePerGbp(this.deps.market, venue, date),
    );
    if (verdict.kind === 'behind') {
      this.log(
        'warn',
        'v2_fill_cumulative_behind',
        `${baseFillId} reports cumulative qty ${fill.qty} below the ${verdict.bookedQty} already booked; ignored`,
      );
      return undefined;
    }
    if (verdict.kind === 'duplicate') return undefined;
    if (verdict.increment.priceDegraded) {
      this.log(
        'warn',
        'v2_fill_increment_price_unusable',
        `${baseFillId}: increment of ${verdict.increment.qty} booked at the cumulative average ${fill.price}`,
      );
    }
    return verdict.increment;
  }

  warnIfFillCrossedFlat(
    order: JournalledOrder,
    leg: V2Fill['leg'],
    before: Position | undefined,
    after: Position | undefined,
  ): void {
    if (after === undefined || !after.stray || (before?.stray ?? false)) return;
    const heldBefore = before === undefined ? 'no position was held' : `qty ${before.qty} held`;
    const message =
      `${order.book_id} ${order.instrument}: a ${leg} fill on ${order.client_order_id} ` +
      `left qty ${after.qty} where ${heldBefore}; a fill must never flip or open a position ` +
      'outside a fresh entry (#1778)';
    this.deps.journal.recordRefusal({
      trading_date: this.tradingDate,
      scope: 'execution',
      parameter: 'CROSSING_FILL',
      ticket: '#1778',
      message,
      book_id: order.book_id,
      instrument: order.instrument,
    });
    this.refusals.push(message);
    this.log('error', 'v2_crossing_fill', message);
  }

  // A position whose rescale threw keeps its pre-split qty and levels: an exit on them trades the
  // wrong qty at the wrong levels and a mark persists a loss-budget row the next cycle sizes from,
  // so both wait for a cycle whose rescale succeeds
  rescaleSplitPositions(): void {
    const thrown: unknown[] = [];
    for (const sleeveId of this.deps.registry.ids()) {
      for (const book of this.deps.books.forSleeve(sleeveId))
        thrown.push(...this.rescaleBook(book));
    }
    if (thrown.length > 0) throw thrown[0];
  }

  rescaleBook(book: BookSpec): unknown[] {
    let positions: readonly Position[];
    try {
      positions = this.deps.books.positions(book.id);
    } catch (error) {
      this.#unrescaledBooks.add(book.id);
      return [error];
    }
    const thrown: unknown[] = [];
    for (const held of positions) {
      try {
        this.rescaleForSplit(book, held);
      } catch (error) {
        this.#unrescaled.add(positionKey(book.id, held.instrument));
        thrown.push(error);
      }
    }
    return thrown;
  }

  refuseMarkIfRescaleThrew(): void {
    const unrescaled = [...this.#unrescaledBooks, ...this.#unrescaled];
    if (unrescaled.length === 0) return;
    const message = `split rescale threw for ${unrescaled.join(', ')}; the date stays unmarked for a retry`;
    this.log('error', 'v2_split_rescale_unmarked', message);
    throw new Error(message);
  }

  rescaleThrew(bookId: string, instrument: string): boolean {
    return (
      this.#unrescaledBooks.has(bookId) || this.#unrescaled.has(positionKey(bookId, instrument))
    );
  }

  rescaleForSplit(book: BookSpec, held: Position): void {
    const anchorDate =
      held.splitAnchorDate ??
      this.deps.market.lastBarBefore(held.instrument, held.openedDate)?.date;
    if (anchorDate === undefined) return;
    const days = calendarDaysBetween(anchorDate, this.tradingDate);
    const bars = this.deps.market
      .barsBefore(held.instrument, this.tradingDate, days)
      .filter((dated) => dated.date >= anchorDate);
    const latest = bars.at(-1);
    if (latest === undefined) return;
    const reading = splitRatioAcross(bars);
    const { ratio, rejected } = reading;
    for (const step of rejected) {
      this.log(
        'warn',
        'v2_split_implausible',
        `${book.id} ${held.instrument}: adjustment step ${step.step} on ${step.date} with adjusted close gap ${step.adjustedGap} is a data discontinuity, not a split; no rescale`,
      );
    }
    if (ratio === 1) return;
    const qty = this.splitHeld(book.id, held, reading, 'detector', latest.date);
    this.log(
      'info',
      'v2_split_rescaled',
      `${book.id} ${held.instrument}: qty ${held.qty} -> ${qty}, levels / ${ratio}`,
    );
    if (!this.deps.executor.simulates(routeOf(book, held.venue))) {
      this.alertBrokerSplit(book.id, held, ratio, qty);
    }
  }

  alertBrokerSplit(bookId: string, held: Position, ratio: number, qty: number): void {
    this.log(
      'error',
      'v2_split_broker_check',
      `${bookId} ${held.instrument}: x${ratio} split on a broker-held position, ledger qty ${held.qty} -> ${qty}; reconcile checks the venue's stop against it and re-places a stale one`,
    );
  }

  atomically<T>(work: () => T): T {
    return this.deps.atomically === undefined ? work() : this.deps.atomically(work);
  }

  // David ruled 2026-10-01 (#1984): the broker keeps whole shares and pays cash for the rest, so
  // the ledger floors too and books the remainder as a disposal; reconcile (#1872) flags any
  // broker qty that differs
  splitHeld(
    bookId: string,
    held: Position,
    reading: SplitReading,
    source: RescaleSource,
    anchorDate: string,
    disposalDate = anchorDate,
  ): number {
    return this.atomically(() => {
      for (const step of reading.steps) {
        this.deps.journal.recordSplit({
          instrument: held.instrument,
          venue: held.venue,
          split_date: step.date,
          ratio: step.ratio,
          trading_date: this.tradingDate,
        });
      }
      this.rescaleHeld(bookId, held.instrument, reading.ratio, anchorDate, source);
      return this.floorHeld(bookId, held.instrument, held.clientOrderId, {
        anchorDate,
        disposalDate,
      });
    });
  }

  rescaleHeld(
    bookId: string,
    instrument: string,
    ratio: number,
    anchorDate: string,
    source: RescaleSource,
  ): void {
    const before = this.deps.books.position(bookId, instrument) as Position;
    this.deps.books.applySplit(bookId, instrument, ratio, anchorDate);
    const after = this.deps.books.position(bookId, instrument) as Position;
    this.deps.journal.recordRescale({
      trading_date: this.tradingDate,
      book_id: bookId,
      instrument,
      source,
      ratio,
      anchor_date: anchorDate,
      before: levelsOf(before),
      after: levelsOf(after),
    });
  }

  // The books keep the latest close, already in post-split units; only the tax log takes the
  // broker's amount, once read after the cycle (#2001)
  floorHeld(
    bookId: string,
    instrument: string,
    sourceOrderId: string,
    dates: { readonly anchorDate: string; readonly disposalDate: string },
  ): number {
    const held = this.deps.books.position(bookId, instrument) as Position;
    const fraction = fractionalShares(held.qty);
    if (fraction === 0) return held.qty;
    const priceGbp = this.markGbp(instrument, held.venue) ?? held.avgPriceGbp;
    this.disposeCashInLieu(bookId, held, { fraction, priceGbp, sourceOrderId, ...dates });
    return held.qty - fraction;
  }

  disposeCashInLieu(
    bookId: string,
    held: Position,
    { fraction, priceGbp, anchorDate, disposalDate, sourceOrderId }: CashInLieu,
  ): void {
    const side: OrderSide = fraction > 0 ? 'sell' : 'buy';
    const qty = Math.abs(fraction);
    const fillFx = fillFxOf(this.deps.market, held.venue, this.tradingDate);
    const recorded = this.deps.journal.recordFill({
      fill_id: `${held.venue}:cash-in-lieu:${bookId}:${held.instrument}:${anchorDate}:${sourceOrderId}`,
      client_order_id: sourceOrderId,
      book_id: bookId,
      trading_date: this.tradingDate,
      instrument: held.instrument,
      venue: held.venue,
      leg: 'cash_in_lieu',
      side,
      qty,
      price_gbp: priceGbp,
      fee_gbp: 0,
      currency: fillFx.currency,
      price_native: priceGbp * fillFx.quotePerGbp,
      fee_native: 0,
      fx_quote_per_gbp: fillFx.quotePerGbp,
      fx_source: fillFx.source,
      fill_date: disposalDate,
      broker_mode: this.deps.brokerMode,
    });
    if (!recorded) return;
    this.deps.books.applyFill(bookId, {
      instrument: held.instrument,
      venue: held.venue,
      side,
      leg: 'cash_in_lieu',
      qty,
      priceGbp,
      feeGbp: 0,
      clientOrderId: sourceOrderId,
      tradingDate: this.tradingDate,
    });
    this.log(
      'warn',
      'v2_split_cash_in_lieu',
      `${bookId} ${held.instrument}: ${qty} share left by the split disposed as cash in lieu at ${priceGbp} GBP, the latest close; the tax log takes the broker's amount once it is read`,
    );
  }

  fillSimulatedEntries(): void {
    for (const order of this.deps.journal.unfilledSimulatedEntriesBefore(this.tradingDate)) {
      this.fillSimulatedEntry(order);
    }
  }

  fillSimulatedEntry(order: JournalledOrder): void {
    const limit = journalledLimit(order) as number;
    const side = order.side as OrderSide;
    const daysOpen = calendarDaysBetween(order.trading_date, this.tradingDate);
    const bars = this.barsSince(order);
    const ratios = cumulativeSplitRatios(
      this.deps.market.lastBarBefore(order.instrument, order.trading_date),
      bars,
    );
    const outcome = simulateLimitEntry(
      {
        side,
        limit,
        stop: numberOrUndefined(order.payload.stop),
        trigger: numberOrUndefined(order.payload.trigger),
        quoteFill: journalledQuoteFill(order.payload),
      },
      bars.map((bar, index) => ({ ...bar, rawClose: bar.rawClose * (ratios[index] as number) })),
    );
    if (outcome.kind === 'pending' && daysOpen <= MAX_PENDING_CALENDAR_DAYS) {
      this.#pendingEntries.add(positionKey(order.book_id, order.instrument));
      return;
    }
    if (outcome.kind !== 'filled') {
      this.deps.journal.markCancelled(order.client_order_id, this.tradingDate);
      return;
    }
    this.settleEntryFill(order, limit, outcome, {
      ratio: ratios.at(-1) as number,
      date: bars.at(-1)?.date as string,
    });
  }

  // The order and its stop are in the units it was priced in, the position book in the latest
  // bar's: a new position books in order units and is rescaled to the latest bar's and anchored
  // there, an add is converted before it books
  settleEntryFill(
    order: JournalledOrder,
    limit: number,
    outcome: FilledLimitEntry,
    units: { readonly ratio: number; readonly date: string },
  ): void {
    const side = order.side as OrderSide;
    const opening = this.deps.books.position(order.book_id, order.instrument) === undefined;
    const qty = order.payload.size as number;
    const quote = this.quoteOrRefuse(order.book_id, order.venue as Venue, {
      instrument: order.instrument,
      side,
      qty,
      price: outcome.price,
      crossesSpread: outcome.crossesSpread,
    });
    if (quote === undefined) {
      this.#pendingEntries.add(positionKey(order.book_id, order.instrument));
      return;
    }
    const bookedUnits = opening ? 1 : units.ratio;
    this.atomically(() => {
      this.ingest({
        client_order_id: order.client_order_id,
        broker_fill_id: `sim-${order.client_order_id}`,
        leg: 'entry',
        price: withinLimit(side, limit, quote.price) / bookedUnits,
        qty: qty * bookedUnits,
        fee: quote.fee,
      });
      this.splitEntryFill(order, units, opening);
    });
    this.afterEntryFill(order, outcome, units);
  }

  afterEntryFill(
    order: JournalledOrder,
    outcome: FilledLimitEntry,
    units: { readonly ratio: number; readonly date: string },
  ): void {
    const held = this.deps.books.position(order.book_id, order.instrument);
    if (outcome.stoppedAt !== undefined && held !== undefined) {
      this.simulatedExit(
        order.book_id,
        held,
        outcome.stoppedAt / units.ratio,
        true,
        'stop_on_entry_bar',
      );
    }
  }

  // An add-on books qty x ratio in the latest bar's units, which the broker would floor too
  splitEntryFill(
    order: JournalledOrder,
    units: { readonly ratio: number; readonly date: string },
    opening: boolean,
  ): void {
    const held = this.deps.books.position(order.book_id, order.instrument);
    if (held === undefined) return;
    if (opening) {
      this.splitHeld(
        order.book_id,
        held,
        { ratio: units.ratio, steps: [], rejected: [] },
        'entry',
        units.date,
      );
      return;
    }
    this.floorHeld(order.book_id, order.instrument, order.client_order_id, {
      anchorDate: units.date,
      disposalDate: units.date,
    });
  }

  quoteOrRefuse(
    bookId: string,
    venue: Venue,
    request: SimulatedFillRequest,
  ): SimulatedFillQuote | undefined {
    try {
      return this.deps.executor.quoteSimulatedFill(venue, request);
    } catch (error) {
      if (!(error instanceof CfdCostModelUnsetError)) throw error;
      const message = `${bookId} ${request.instrument}: simulated ${venue} fill left open, ${error.message}`;
      this.deps.journal.recordRefusal({
        trading_date: this.tradingDate,
        scope: 'fill',
        parameter: 'CFD_COST_MODEL',
        ticket: '#1850',
        message,
        book_id: bookId,
        instrument: request.instrument,
      });
      this.refusals.push(message);
      return undefined;
    }
  }

  barsSince(order: JournalledOrder): readonly V2Bar[] {
    const days = calendarDaysBetween(order.trading_date, this.tradingDate) + 1;
    return this.deps.market
      .barsBefore(order.instrument, this.tradingDate, days)
      .filter((bar) => bar.date >= order.trading_date);
  }

  fillSimulatedExits(): void {
    for (const bookId of this.deps.books.ids()) {
      for (const held of this.deps.books.positions(bookId)) {
        if (!this.rescaleThrew(bookId, held.instrument)) this.fillSimulatedExit(held);
      }
    }
  }

  fillSimulatedExit(held: Position): void {
    if (held.exitClientOrderId === undefined) return;
    const order = this.deps.journal.orderFor(held.exitClientOrderId);
    if (
      order === undefined ||
      !(SIMULATED_OUTCOMES as ReadonlySet<JournalledOutcome>).has(order.outcome)
    )
      return;
    const price = simulateMarketExit(this.barsSince(order));
    if (price === undefined) {
      this.fillPendingExitAtLastClose(order, held);
      return;
    }
    this.settleExitFill(order, held, price);
  }

  settleExitFill(order: JournalledOrder, held: Position, price: number): boolean {
    const qty = Math.abs(held.qty);
    const quote = this.quoteOrRefuse(order.book_id, held.venue, {
      instrument: held.instrument,
      side: order.side,
      qty,
      price,
      crossesSpread: true,
    });
    if (quote === undefined) return false;
    this.ingest({
      client_order_id: order.client_order_id,
      broker_fill_id: `sim-${order.client_order_id}`,
      leg: 'exit',
      price: quote.price,
      qty,
      fee: quote.fee,
    });
    return true;
  }

  fillPendingExitAtLastClose(order: JournalledOrder, held: Position): void {
    const bar = this.endedSeriesBar(order.instrument);
    if (bar === undefined) {
      this.warnIfStale(order);
      return;
    }
    if (this.settleExitFill(order, held, bar.rawClose)) {
      this.logEndedSeries(order.book_id, order.instrument, bar);
    }
  }

  endedSeriesBar(instrument: string): V2Bar | undefined {
    if (this.deps.closeEndedSeries !== true) return undefined;
    const bar = this.deps.market.lastBarBefore(instrument, this.tradingDate);
    return isFresh(bar, this.tradingDate) ? undefined : bar;
  }

  logEndedSeries(bookId: string, instrument: string, bar: V2Bar): void {
    this.log(
      'info',
      'v2_series_ended_exit',
      `${bookId} ${instrument}: series ended ${bar.date}, closed at its last close (doc 70 §2.4)`,
    );
  }

  simulatedEndedSeriesExit(bookId: string, instrument: string): void {
    const held = this.deps.books.position(bookId, instrument);
    if (held === undefined || held.exitClientOrderId !== undefined) return;
    const bar = this.endedSeriesBar(instrument);
    if (bar === undefined) return;
    this.simulatedExit(bookId, held, bar.rawClose, true, 'series_ended_at_last_close');
    if (this.deps.books.position(bookId, instrument) === undefined) {
      this.logEndedSeries(bookId, instrument, bar);
    }
  }

  warnIfStale(order: JournalledOrder): void {
    if (calendarDaysBetween(order.trading_date, this.tradingDate) <= MAX_PENDING_CALENDAR_DAYS) {
      return;
    }
    this.log(
      'warn',
      'v2_simulated_flatten_stale',
      `${order.book_id} ${order.instrument}: flatten ${order.client_order_id} has had no bar since ${order.trading_date}`,
    );
  }

  async cancelStaleEntries(book: BookSpec): Promise<void> {
    const { journal } = this.deps;
    await this.cancelEntries(
      book,
      journal.unfilledEntriesBefore(book.id, this.tradingDate),
      'rearm',
      journal.partFilledEntries(book.id, this.tradingDate),
    );
  }

  async cancelEntries(
    book: BookSpec,
    orders: readonly JournalledOrder[],
    protect: PartFillProtection,
    booked: readonly JournalledOrder[],
  ): Promise<number> {
    let cancelled = 0;
    const partFilled: JournalledOrder[] = [];
    for (const order of [...orders, ...booked]) {
      const filled = await this.cancelRoutable(book, order);
      if (filled === undefined) continue;
      cancelled += 1;
      if (filled > 0 || booked.includes(order)) partFilled.push(order);
    }
    if (partFilled.length > 0) await this.protectPartFills(book, partFilled, protect);
    return cancelled;
  }

  cancelRoutable(book: BookSpec, order: JournalledOrder): Promise<number | undefined> {
    const route = routeOf(book, order.venue as Venue);
    if (!this.deps.executor.canRoute(route)) return Promise.resolve(undefined);
    return this.cancelEntry(book, route, order);
  }

  // The journal calls an entry unfilled until a sweep books its fill, and Alpaca holds a bracket's
  // legs until the entry fills completely, so a part fill the venue reports has no live stop
  async cancelEntry(
    book: BookSpec,
    route: ExecutionRoute,
    order: JournalledOrder,
  ): Promise<number | undefined> {
    const { client_order_id: id, instrument } = order;
    let filled: number | undefined;
    try {
      filled = await this.deps.executor.filledQty(route, id, instrument);
    } catch (error) {
      this.recordFillRead(id, null, describeThrownSafely(error));
      return this.keepEntry(book, order, 'error', 'v2_entry_fill_read_failed', error);
    }
    this.recordFillRead(id, filled ?? null, null);
    try {
      await this.deps.executor.cancel(route, id, instrument);
      this.deps.journal.markCancelled(id, this.tradingDate);
    } catch (error) {
      return this.keepEntry(book, order, 'warn', 'v2_cancel_failed', error);
    }
    return filled ?? 0;
  }

  recordFillRead(clientOrderId: string, filledQty: number | null, error: string | null): void {
    this.deps.journal.recordFillRead({
      run_id: this.runId,
      trading_date: this.tradingDate,
      client_order_id: clientOrderId,
      filled_qty: filledQty,
      error,
    });
  }

  // Still resting at the broker: block a fresh opposite entry here too, or its fill could later
  // cross the stale one's fill and flip the position unnoticed (#1778)
  keepEntry(
    book: BookSpec,
    order: JournalledOrder,
    level: 'error' | 'warn',
    event: 'v2_entry_fill_read_failed' | 'v2_cancel_failed',
    error: unknown,
  ): undefined {
    this.#pendingEntries.add(positionKey(book.id, order.instrument));
    this.log(level, event, `${order.client_order_id}: ${describeThrownSafely(error)}`);
    return undefined;
  }

  // The fill is booked now so the same run protects it: a stop at the ledger level, or the halt's
  // exit. One the sweep has not delivered yet is left to the next run's reconcile, which re-arms it
  async protectPartFills(
    book: BookSpec,
    orders: readonly JournalledOrder[],
    protect: PartFillProtection,
  ): Promise<void> {
    await this.sweepFills();
    for (const order of orders) await this.protectPartFill(book, order, protect);
  }

  async protectPartFill(
    book: BookSpec,
    order: JournalledOrder,
    protect: PartFillProtection,
  ): Promise<void> {
    const held = this.deps.books.position(book.id, order.instrument);
    if (held === undefined) {
      this.log(
        'error',
        'v2_part_fill_unbooked',
        `${order.client_order_id}: cancelled with a fill the venue reports and the sweep has not delivered; the next reconcile re-arms it`,
      );
      return;
    }
    if (!stopReplaceable(held, order.venue as Venue)) return;
    if (protect === 'exit') await this.submitExit(book, held, 'manual_halt');
    else await this.replaceStop(book, held);
  }

  async cancelEntriesBlockedAtLastMark(): Promise<void> {
    for (const sleeveId of this.deps.registry.ids()) {
      for (const book of this.deps.books.forSleeve(sleeveId)) {
        const last = this.deps.books.lastDay(book.id);
        if (last !== undefined)
          await this.cancelRestingEntriesOnBlock(book, last.state, last.tradingDate);
      }
    }
  }

  async cancelRestingEntriesOnBlock(
    book: BookSpec,
    state: LossBudgetState,
    markDate: string,
  ): Promise<void> {
    if (!state.halted && !state.entriesBlockedAtNextFill) return;
    const { journal } = this.deps;
    const cancelled = await this.cancelEntries(
      book,
      journal.restingEntries(book.id),
      'rearm',
      journal.partFilledEntries(book.id),
    );
    if (cancelled === 0) return;
    const cause = state.halted ? 'loss budget halt' : 'daily loss cap';
    const message = `${book.id}: ${cause} at the ${markDate} mark cancelled resting entries: ${cancelled}`;
    this.deps.journal.recordRefusal({
      trading_date: this.tradingDate,
      scope: 'entry',
      parameter: 'LOSS_BUDGET',
      ticket: '#1813',
      message,
      book_id: book.id,
    });
    this.refusals.push(message);
  }

  simulatedBracketExit(book: BookSpec, held: Position): void {
    if (held.exitClientOrderId !== undefined) return;
    const bar = this.deps.market.lastBarBefore(held.instrument, this.tradingDate);
    if (bar === undefined || bar.date < held.openedDate) return;
    const fx = this.fxFor(held.venue);
    const toRawGbp = bar.rawClose / bar.close / fx;
    const exit = bracketExit(held, bar.open * toRawGbp, bar.low * toRawGbp, bar.high * toRawGbp);
    if (exit?.priceGbp === undefined) return;
    this.simulatedExit(
      book.id,
      held,
      exit.priceGbp * fx,
      exit.crossesSpread,
      'bracket_leg_on_daily_bar',
    );
  }

  simulatedExit(
    bookId: string,
    held: Position,
    trigger: number,
    crossesSpread: boolean,
    detail: string,
  ): void {
    const side: OrderSide = held.qty > 0 ? 'sell' : 'buy';
    const clientOrderId = this.exitOrderId(bookId, held.instrument);
    if (this.deps.journal.orderFor(clientOrderId) !== undefined) return;
    const quote = this.quoteOrRefuse(bookId, held.venue, {
      instrument: held.instrument,
      side,
      qty: Math.abs(held.qty),
      price: trigger,
      crossesSpread,
    });
    if (quote === undefined) return;
    this.tally.exits += 1;
    this.tally.simulated += 1;
    this.deps.journal.recordOrder({
      client_order_id: clientOrderId,
      decision_id: null,
      book_id: bookId,
      trading_date: this.tradingDate,
      instrument: held.instrument,
      venue: held.venue,
      leg: 'exit',
      side,
      dry_run: this.deps.dryRun,
      outcome: 'simulated',
      payload: {
        size: Math.abs(held.qty),
        detail,
        price: trigger,
      },
    });
    this.ingest({
      client_order_id: clientOrderId,
      broker_fill_id: `sim-${clientOrderId}`,
      leg: 'exit',
      price: quote.price,
      qty: Math.abs(held.qty),
      fee: quote.fee,
    });
  }

  exitOrderId(bookId: string, instrument: string): string {
    return `v2-${bookId.replaceAll('/', '-')}-${this.tradingDate}-${instrument}-exit`;
  }

  async timeStop(book: BookSpec, held: Position): Promise<void> {
    const { timeStopTradingDays } = this.deps.registry.spec(book.sleeve).sizing;
    if (held.marksHeld < timeStopTradingDays || held.exitClientOrderId !== undefined) return;
    if (!this.deps.executor.canRoute(routeOf(book, held.venue))) return;
    await this.submitExit(book, held, 'time_stop');
  }

  async haltExits(book: BookSpec): Promise<void> {
    for (const held of this.deps.books.positions(book.id)) {
      if (held.exitClientOrderId !== undefined || this.rescaleThrew(book.id, held.instrument)) {
        continue;
      }
      if (this.deps.executor.canRoute(routeOf(book, held.venue))) {
        await this.submitExit(book, held, 'manual_halt');
        continue;
      }
      const message = `halt could not exit ${held.instrument} in ${book.id}: no route to ${held.venue}`;
      this.deps.journal.recordRefusal({
        trading_date: this.tradingDate,
        scope: 'control',
        parameter: 'MANUAL_HALT',
        ticket: CONTROL_TICKET,
        message,
        book_id: book.id,
        instrument: held.instrument,
      });
      this.refusals.push(message);
    }
  }

  async submitExit(book: BookSpec, held: Position, reason: ExitReason): Promise<void> {
    const clientOrderId = this.exitOrderId(book.id, held.instrument);
    if (this.deps.journal.orderFor(clientOrderId) !== undefined) return;
    this.tally.exits += 1;
    // Policy, not staleness: an unexpected crossing fill is never trusted as an intentional
    // new entry, even when its own bracket levels would otherwise resolve cleanly (#1778)
    const rearm = held.stray ? undefined : nativeRearmPrices(this.deps.journal, held);
    const order = this.deps.risk.approveExit({ book, held, clientOrderId, rearm });
    const submission = await this.submitExitLeg(book, held, clientOrderId, order, {
      marks_held: held.marksHeld,
      reason,
    });
    if (submission.outcome !== 'rejected') {
      this.deps.books.setExitPending(book.id, held.instrument, clientOrderId);
    }
  }

  async submitExitLeg(
    book: BookSpec,
    held: Position,
    clientOrderId: string,
    order: RiskApprovedOrder,
    legPayload: Record<string, unknown>,
  ): Promise<Submission> {
    const submission = await this.deps.executor.submit(order);
    this.count(submission.outcome);
    this.deps.journal.recordOrder({
      client_order_id: clientOrderId,
      decision_id: null,
      book_id: book.id,
      trading_date: this.tradingDate,
      instrument: held.instrument,
      venue: held.venue,
      leg: 'exit',
      side: order.side,
      dry_run: this.deps.dryRun,
      outcome: submission.outcome,
      payload: {
        size: order.size,
        detail: submission.detail,
        failed_step: submission.failedStep,
        ...legPayload,
        modelled_slippage_bps: this.exitSlippageBps(held, order.size, submission.outcome),
        approval: submission.approvalId,
      },
    });
    return submission;
  }

  count(outcome: OrderOutcome): void {
    if (outcome === 'submitted') this.tally.submitted += 1;
    else if (outcome === 'refused_dry_run') this.tally.refused += 1;
    else if (outcome === 'simulated') this.tally.simulated += 1;
    else this.tally.rejected += 1;
  }

  async resumePendingExit(book: BookSpec, held: Position): Promise<void> {
    if (held.exitClientOrderId === undefined) return;
    const exitClientOrderId = held.exitClientOrderId;
    let resumed: Awaited<ReturnType<OrderExecutor['resumeFlatten']>>;
    try {
      resumed = await this.deps.executor.resumeFlatten(
        routeOf(book, held.venue),
        exitClientOrderId,
        held.instrument,
      );
    } catch (error) {
      this.log('warn', 'v2_resume_flatten_failed', describeThrownSafely(error));
      return;
    }
    if (resumed === undefined) return;
    if (resumed.orderState === 'submitted' || resumed.orderState === 'partially_filled') return;
    await this.clearAndRearmIfBracketed(book, held.instrument, exitClientOrderId);
  }

  async clearAndRearmIfBracketed(
    book: BookSpec,
    instrument: string,
    exitClientOrderId: string,
  ): Promise<void> {
    const stillHeld = this.deps.books.position(book.id, instrument);
    if (stillHeld === undefined) return;
    this.deps.books.clearExitPending(book.id, instrument);
    // A stray has no legitimate bracket to rearm to; crossingFillExit re-submits the flatten instead
    if (stillHeld.stray) return;
    await this.rearmBackstop(book, stillHeld, exitClientOrderId);
  }

  rearmOrderId(bookId: string, instrument: string): string {
    return `v2-${bookId.replaceAll('/', '-')}-${this.tradingDate}-${instrument}-rearm`;
  }

  async rearmBackstop(book: BookSpec, held: Position, exitClientOrderId: string): Promise<void> {
    const rearm = nativeRearmPrices(this.deps.journal, held);
    if (rearm === undefined) {
      const message =
        `${book.id} ${held.instrument}: exit ${exitClientOrderId} ended without flattening the ` +
        'position and no journalled entry rearm price exists; the position is UNPROTECTED';
      this.deps.journal.recordRefusal({
        trading_date: this.tradingDate,
        scope: 'execution',
        parameter: 'REARM_BACKSTOP',
        ticket: '#1801',
        message,
        book_id: book.id,
        instrument: held.instrument,
      });
      this.refusals.push(message);
      this.log('error', 'v2_rearm_backstop_missing_prices', message);
      return;
    }
    const clientOrderId = this.rearmOrderId(book.id, held.instrument);
    if (this.deps.journal.orderFor(clientOrderId) !== undefined) return;
    if (!this.deps.executor.canRoute(routeOf(book, held.venue))) return;
    const order = this.deps.risk.approveRearm({
      book,
      held,
      clientOrderId,
      stop: rearm.stop,
      target: rearm.target,
    });
    const submission = await this.submitExitLeg(book, held, clientOrderId, order, {
      stop: rearm.stop,
      target: rearm.target,
      exit_client_order_id: exitClientOrderId,
    });
    if (submission.outcome === 'rejected') {
      const message = `${book.id} ${held.instrument}: backstop rearm after exit ${exitClientOrderId} failed: ${submission.detail}`;
      this.refusals.push(message);
      this.log('error', 'v2_rearm_backstop_failed', message);
    }
  }

  stopReplaceOrderId(bookId: string, instrument: string): string {
    return `v2-${bookId.replaceAll('/', '-')}-${this.tradingDate}-${instrument}-restop`;
  }

  brokerHolders({ venue, instrument }: StaleStop): [BookSpec, Position][] {
    return this.deps.registry.ids().flatMap((sleeveId) =>
      this.deps.books.forSleeve(sleeveId).flatMap((book): [BookSpec, Position][] => {
        const held = this.deps.books.position(book.id, instrument);
        if (!stopReplaceable(held, venue)) return [];
        return this.deps.executor.simulates(routeOf(book, venue)) ? [] : [[book, held]];
      }),
    );
  }

  // David 2026-10-02 (#1990): a stop that no longer matches the ledger is cancelled and re-placed,
  // and a holding with none is re-armed the same way; a failed place flattens, a failed cancel
  // does nothing more. Entries stay blocked by the mismatch that found it
  async replaceStaleStops(staleStops: readonly StaleStop[]): Promise<void> {
    for (const stale of staleStops) {
      for (const [book, held] of this.brokerHolders(stale)) await this.replaceStop(book, held);
    }
  }

  async replaceStop(book: BookSpec, held: Position): Promise<void> {
    const base = this.stopReplaceOrderId(book.id, held.instrument);
    const clientOrderId = nextRestopId(this.deps.journal, base);
    if (clientOrderId === null) {
      this.stopReplaceAlert(
        'v2_stop_replace_exhausted',
        `${book.id} ${held.instrument}: ${MAX_RESTOP_ATTEMPTS} stop replaces already sent this date; nothing more is sent until the next date`,
      );
      return;
    }
    const prices = nativeRearmPrices(this.deps.journal, held);
    if (prices === undefined) {
      this.stopReplaceAlert(
        'v2_stop_replace_unpriced',
        `${book.id} ${held.instrument}: the venue's stop is missing or does not match the ledger and no journalled entry stop exists to re-place it at; nothing was cancelled`,
      );
      return;
    }
    const order = this.deps.risk.approveStopReplace({ book, held, clientOrderId, ...prices });
    const submission = await this.submitExitLeg(book, held, clientOrderId, order, {
      ...prices,
      reason: 'split_stop_replace',
    });
    await this.afterStopReplace(book, held, submission);
  }

  async afterStopReplace(book: BookSpec, held: Position, submission: Submission): Promise<void> {
    const subject = `${book.id} ${held.instrument}`;
    if (submission.outcome !== 'rejected') {
      this.log('warn', 'v2_stop_replaced', `${subject}: ${stopReplacedMessage(submission.detail)}`);
      return;
    }
    if (submission.failedStep === 'place') {
      this.stopReplaceAlert(
        'v2_stop_replace_failed',
        `${subject}: any stale stop cancelled but the place failed, flattening at market: ${submission.detail}`,
      );
      await this.submitExit(book, held, 'stop_replace_failed');
      return;
    }
    const [event, what] = stopReplaceRefusal(submission.failedStep);
    this.stopReplaceAlert(event, `${subject}: ${what}: ${submission.detail}`);
  }

  stopReplaceAlert(event: string, message: string): void {
    this.refusals.push(message);
    this.log('error', event, message);
  }

  async exits(book: BookSpec, decisions: readonly SleeveDecision[]): Promise<void> {
    const exitSignalled = new Set(
      decisions
        .filter((decision) => decision.action === 'exit')
        .map((decision) => decision.instrument),
    );
    for (const held of this.deps.books.positions(book.id)) {
      await this.exitHeldPosition(book, held, exitSignalled);
    }
    if (this.control.state === 'halted') await this.haltExits(book);
  }

  async exitHeldPosition(
    book: BookSpec,
    held: Position,
    exitSignalled: ReadonlySet<string>,
  ): Promise<void> {
    if (this.rescaleThrew(book.id, held.instrument)) return;
    await this.resumePendingExit(book, held);
    if (this.deps.executor.simulates(routeOf(book, held.venue))) {
      this.simulatedBracketExit(book, held);
      this.simulatedEndedSeriesExit(book.id, held.instrument);
    }
    const afterSimulated = this.deps.books.position(book.id, held.instrument);
    if (afterSimulated === undefined) return;
    await this.crossingFillExit(book, afterSimulated);
    const afterCrossing = this.deps.books.position(book.id, held.instrument);
    if (afterCrossing === undefined) return;
    await this.signalExit(book, afterCrossing, exitSignalled);
    const afterSignal = this.deps.books.position(book.id, held.instrument);
    if (afterSignal !== undefined) await this.timeStop(book, afterSignal);
  }

  async crossingFillExit(book: BookSpec, held: Position): Promise<void> {
    if (held.exitClientOrderId !== undefined || !held.stray) return;
    if (!this.deps.executor.canRoute(routeOf(book, held.venue))) return;
    await this.submitExit(book, held, 'crossing_fill');
  }

  async signalExit(
    book: BookSpec,
    held: Position,
    exitSignalled: ReadonlySet<string>,
  ): Promise<void> {
    if (!exitSignalled.has(held.instrument) || held.exitClientOrderId !== undefined) return;
    if (!this.deps.executor.canRoute(routeOf(book, held.venue))) return;
    await this.submitExit(book, held, 'signal_exit');
  }

  entryOrderId(book: BookSpec, instrument: string): string {
    return this.entryOrderIdFor(book, instrument, this.tradingDate);
  }

  async submitEntry(
    book: BookSpec,
    decision: SleeveDecision,
    decisionId: string,
    approval: EntryApproval,
  ): Promise<OrderOutcome | undefined> {
    const clientOrderId = this.entryOrderId(book, decision.instrument);
    if (!this.willSubmitEntry(book, decision)) {
      this.journalHeldByBrokerBook(book, decision);
      return undefined;
    }
    this.tally.entries += 1;
    const side: OrderSide = decision.action === 'enter_short' ? 'sell' : 'buy';
    const row = {
      client_order_id: clientOrderId,
      decision_id: decisionId,
      book_id: book.id,
      trading_date: this.tradingDate,
      instrument: decision.instrument,
      venue: decision.venue,
      leg: 'entry' as const,
      side,
      dry_run: this.deps.dryRun,
    };
    if (approval.order === undefined) {
      const refused: OrderOutcome = 'rejected';
      this.count(refused);
      this.deps.journal.recordOrder({
        ...row,
        outcome: refused,
        payload: this.entryPayload(decision, approval, side, approval.refusal, false),
      });
      return refused;
    }
    // David 2026-10-04 (#1747): journal before submit, so a crash after the send leaves an id
    // reconcile can match to the venue's order
    const sent = !this.deps.executor.simulates(routeOf(book, decision.venue));
    this.deps.journal.recordOrder({
      ...row,
      outcome: 'pending',
      payload: this.entryPayload(decision, approval, side, '', sent),
    });
    const submission = await this.deps.executor.submit(approval.order);
    this.count(submission.outcome);
    this.deps.journal.settleOrder(
      clientOrderId,
      submission.outcome,
      this.entryPayload(
        decision,
        approval,
        side,
        submission.detail,
        submission.outcome === 'submitted',
      ),
    );
    return submission.outcome;
  }

  entryPayload(
    decision: SleeveDecision,
    approval: EntryApproval,
    side: OrderSide,
    detail: string,
    sent: boolean,
  ): Record<string, unknown> {
    const limit = approvedLimit(approval);
    return {
      size: approval.size,
      detail,
      price: decision.price,
      limit,
      entry_offset_bps: approval.entryOffsetBps,
      modelled_slippage_bps: sent
        ? this.modelledSlippageBps(
            decision.venue,
            {
              instrument: decision.instrument,
              side,
              qty: approval.size,
              price: limit ?? decision.price,
              crossesSpread: true,
            },
            'submitted',
          )
        : undefined,
      trigger: decision.entry_trigger,
      entry_quote: decision.entry_quote,
      stop: decision.stop_price,
      target: approval.order?.kind === 'bracket_entry' ? approval.order.target : undefined,
      approval: approval.order?.approvalId,
    };
  }

  // Only a submitted order reached a broker, so only its modelled cost is ever compared. The
  // slippage a crossing fill would be charged at the cost tables of the day the order goes out,
  // journalled so a later table refresh does not move the cost-fidelity check (#1884)
  modelledSlippageBps(
    venue: Venue,
    request: SimulatedFillRequest,
    outcome: OrderOutcome,
  ): number | undefined {
    if (outcome !== 'submitted' || request.price <= 0) return undefined;
    const quote = this.deps.executor.quoteSimulatedFill(venue, request);
    return (Math.abs(quote.price - request.price) / request.price) * BPS;
  }

  exitSlippageBps(held: Position, qty: number, outcome: OrderOutcome): number | undefined {
    const bar = this.deps.market.lastBarBefore(held.instrument, this.tradingDate);
    if (bar === undefined) return undefined;
    const side: OrderSide = held.qty > 0 ? 'sell' : 'buy';
    return this.modelledSlippageBps(
      held.venue,
      { instrument: held.instrument, side, qty, price: bar.rawClose, crossesSpread: true },
      outcome,
    );
  }

  notionalGbp(decision: SleeveDecision, approval: EntryApproval): number {
    const limit = approvedLimit(approval) ?? decision.price;
    return (approval.size * limit) / this.fxFor(decision.venue);
  }

  restingNotionalGbp(bookId: string): number {
    let total = 0;
    for (const order of this.deps.journal.restingEntries(bookId)) {
      const size = numberOrUndefined(order.payload.size) ?? 0;
      const price = journalledLimit(order) ?? 0;
      total += (size * price) / this.fxFor(order.venue as Venue);
    }
    return total;
  }

  // #submitEntry no-ops when a client order already exists, a position is already held, an
  // entry for this instrument is mid-cycle-fill (#pendingEntries), or another broker-routed book
  // holds or rests it — the cash gate must only
  // charge and refuse decisions that take that path, or held/resting lines eat phantom cash and
  // starve later instruments in list order (doc 66 2026-09-28, #1785)
  willSubmitEntry(book: BookSpec, decision: SleeveDecision): boolean {
    const { instrument } = decision;
    return (
      this.deps.journal.orderFor(this.entryOrderId(book, instrument)) === undefined &&
      this.deps.books.position(book.id, instrument) === undefined &&
      !this.#pendingEntries.has(positionKey(book.id, instrument)) &&
      this.brokerBookHolding(book, decision) === undefined
    );
  }

  // One Alpaca account serves every broker-routed book, so an entry on a symbol another such
  // book holds or rests would net against it at the broker and its stop legs would compete (#1941)
  brokerBookHolding(book: BookSpec, decision: SleeveDecision): string | undefined {
    const routed = (candidate: BookSpec) =>
      !this.deps.executor.simulates(routeOf(candidate, decision.venue));
    if (!routed(book)) return undefined;
    return this.deps.registry
      .ids()
      .flatMap((id) => this.deps.books.forSleeve(id))
      .find(
        (other) =>
          other.id !== book.id &&
          routed(other) &&
          this.holdsOrRestsAt(other.id, decision.instrument, decision.venue),
      )?.id;
  }

  holdsOrRestsAt(bookId: string, instrument: string, venue: Venue): boolean {
    if (this.deps.books.position(bookId, instrument)?.venue === venue) return true;
    return this.deps.journal
      .restingEntries(bookId)
      .some((order) => order.instrument === instrument && order.venue === venue);
  }

  journalHeldByBrokerBook(book: BookSpec, decision: SleeveDecision): void {
    const holder = this.brokerBookHolding(book, decision);
    if (holder === undefined) return;
    const message = `${book.id} ${decision.instrument}: held or resting in ${holder} at ${decision.venue}`;
    this.deps.journal.recordRefusal({
      trading_date: this.tradingDate,
      scope: 'entry',
      parameter: 'symbol_held_by_broker_book',
      ticket: '#1941',
      message,
      book_id: book.id,
      instrument: decision.instrument,
    });
    this.refusals.push(message);
  }

  applyRoomGate(decision: SleeveDecision, approval: EntryApproval, room: EntryRoom): EntryApproval {
    if (approval.order === undefined || approval.size <= 0) return approval;
    const refusal = this.deps.risk.entryRoomRefusal(this.notionalGbp(decision, approval), room);
    return refusal === undefined ? approval : { size: approval.size, order: undefined, refusal };
  }

  resolveEntryGate(
    book: BookSpec,
    proposed: SleeveDecision,
    equityGbp: number,
    room: EntryRoom,
  ): { decision: SleeveDecision; gated: EntryApproval } {
    const decision = vetoApplied(book, proposed);
    const approval = this.deps.risk.approveEntry({
      book,
      decision,
      clientOrderId: this.entryOrderId(book, decision.instrument),
      tradingDate: this.tradingDate,
      equityGbp,
      macroDay: this.macro.macroDay,
    });
    const willSubmit =
      approval.order !== undefined && approval.size > 0 && this.willSubmitEntry(book, decision);
    const gated = willSubmit ? this.applyRoomGate(decision, approval, room) : approval;
    return { decision, gated };
  }

  async settleEntry(
    book: BookSpec,
    decision: SleeveDecision,
    gated: EntryApproval,
    charge: () => void,
  ): Promise<void> {
    const decisionId = this.deps.journal.recordDecision(
      book.id,
      this.tradingDate,
      decision,
      gated.size,
    );
    if (gated.order === undefined) this.journalSizingRefusal(book, decision, gated.refusal);
    if (gated.size <= 0) return;
    const outcome = await this.submitEntry(book, decision, decisionId, gated);
    // outcome is undefined or 'rejected' whenever gated.order is undefined too (submitEntry's
    // early-return guards mirror willSubmitEntry, and a sizing refusal always yields 'rejected'),
    // so outcome alone decides: a broker-level 'rejected' never rests (journal.restingEntries
    // excludes it) and must never reserve cash against later decisions this cycle (doc 66
    // 2026-09-28, #1785)
    if (outcome !== undefined && outcome !== 'rejected') charge();
  }

  blockEntries(outcome: ReconcileOutcome): void {
    for (const bookId of outcome.blockedBookIds) this.#entriesBlocked.add(bookId);
    this.refusals.push(...outcome.refusals);
  }

  journalBlockedDecisions(book: BookSpec, decisions: readonly SleeveDecision[]): void {
    for (const proposed of decisions) {
      this.deps.journal.recordDecision(book.id, this.tradingDate, vetoApplied(book, proposed), 0);
    }
  }

  async entries(book: BookSpec, decisions: readonly SleeveDecision[]): Promise<void> {
    if (this.#entriesBlocked.has(book.id)) {
      this.journalBlockedDecisions(book, decisions);
      return;
    }
    const { equityGbp, investedGbp } = this.deps.books.valuation(book.id, (i, v) =>
      this.markGbp(i, v),
    );
    const restingGbp = this.restingNotionalGbp(book.id);
    const room = this.deps.risk.entryRoom(
      equityGbp,
      this.deps.books.cash(book.id) - restingGbp,
      investedGbp + restingGbp,
    );
    for (const proposed of decisions) {
      const { decision, gated } = this.resolveEntryGate(book, proposed, equityGbp, room);
      await this.settleEntry(book, decision, gated, () => {
        const notionalGbp = this.notionalGbp(decision, gated);
        room.cashGbp -= notionalGbp;
        room.grossGbp -= notionalGbp;
      });
    }
  }

  withoutSittingOut(book: BookSpec, decisions: readonly SleeveDecision[]): SleeveDecision[] {
    const gate = this.deps.venueSessions;
    if (gate === undefined) return [...decisions];
    return decisions.filter((proposed) => {
      const code = isEntryAction(proposed)
        ? gate.entrySitOut(proposed.venue, this.tradingDate, this.runStartedAt)
        : undefined;
      if (code === undefined) return true;
      this.journalSitOut(book, proposed, code);
      return false;
    });
  }

  journalSitOut(book: BookSpec, proposed: SleeveDecision, code: SitOutCode): void {
    this.deps.journal.recordDecision(book.id, this.tradingDate, vetoApplied(book, proposed), 0);
    const message = `${book.id} ${proposed.instrument}: ${proposed.venue} entry sits out (${code})`;
    this.deps.journal.recordRefusal({
      trading_date: this.tradingDate,
      scope: 'entry',
      parameter: code,
      ticket: '#1933',
      message,
      book_id: book.id,
      instrument: proposed.instrument,
    });
    this.refusals.push(message);
  }

  journalSizingRefusal(book: BookSpec, decision: SleeveDecision, refusal?: string): void {
    const parameter = SIZING_REFUSAL_PARAMETERS[refusal ?? ''];
    if (parameter === undefined) return;
    this.deps.journal.recordRefusal({
      trading_date: this.tradingDate,
      scope: 'entry',
      parameter,
      ticket: SIZING_REFUSAL_TICKETS[refusal ?? ''] ?? 'docs/research/66-v2-grill-decisions.md D8',
      message: `${book.id} ${decision.instrument}: ${refusal}`,
      book_id: book.id,
      instrument: decision.instrument,
    });
  }

  async markAll(books: readonly BookSpec[]): Promise<BookReport[]> {
    const previous = new Map(books.map((book) => [book.id, this.deps.books.lastDay(book.id)]));
    for (const book of books) this.markOne(book, previous.get(book.id));
    const reports: BookReport[] = [];
    for (const book of books) reports.push(await this.reportMark(book, previous.get(book.id)));
    return reports;
  }

  journalStaleMarks(book: BookSpec): void {
    for (const held of this.deps.books.positions(book.id)) {
      const bar = this.deps.market.lastBarBefore(held.instrument, this.tradingDate);
      const barDate = bar?.date;
      if (isFresh(bar, this.tradingDate)) continue;
      const price = barDate === undefined ? 'the entry price' : `the ${barDate} close`;
      const message = `${book.id} ${held.instrument}: marked at ${price}, no bar in the ${MAX_BAR_AGE_CALENDAR_DAYS} days before ${this.tradingDate}`;
      this.deps.journal.recordRefusal({
        trading_date: this.tradingDate,
        scope: 'data',
        parameter: 'MARK_FRESHNESS',
        ticket: '#1804',
        message,
        book_id: book.id,
        instrument: held.instrument,
      });
      this.refusals.push(message);
    }
  }

  markOne(book: BookSpec, previous: BookDay | undefined): void {
    this.journalStaleMarks(book);
    this.deps.books.markDay(
      book.id,
      this.tradingDate,
      (i, v) => this.markGbp(i, v),
      calendarDaysBetween(previous?.tradingDate, this.tradingDate),
      this.deps.venueSessions?.timeStopPausedVenues(previous?.tradingDate, this.tradingDate),
    );
  }

  async reportMark(book: BookSpec, previous: BookDay | undefined): Promise<BookReport> {
    const day = this.deps.books.lastDay(book.id);
    if (day === undefined) throw new Error(`Cycle: ${book.id} unmarked after markAll`);
    await this.cancelRestingEntriesOnBlock(book, day.state, this.tradingDate);
    this.logBudgetChange(book.id, previous?.state, day.state);
    return {
      book_id: book.id,
      equity_gbp: day.equityGbp,
      cash_gbp: day.cashGbp,
      size_multiplier: day.state.entriesBlockedAtNextFill ? 0 : day.state.sizeMultiplier,
      positions: this.deps.books.positions(book.id).length,
    };
  }

  logBudgetChange(bookId: string, before: LossBudgetState | undefined, after: LossBudgetState) {
    for (const change of budgetChanges(bookId, before, after)) {
      this.log(change.level, change.event, change.message);
    }
  }

  log(level: 'error' | 'warn' | 'info', event: string, message: string): void {
    this.deps.logger?.log({
      trace_id: `v2-${this.tradingDate}`,
      stage: 'v2',
      level,
      event,
      message,
    });
  }
}

export interface BudgetChange {
  readonly level: 'error' | 'warn';
  readonly event: string;
  readonly message: string;
}

export function budgetChanges(
  bookId: string,
  before: LossBudgetState | undefined,
  after: LossBudgetState,
): BudgetChange[] {
  const loss = `year-to-date loss £${after.ytdLossGbp.toFixed(2)}`;
  const changes: BudgetChange[] = [];
  if (after.halted && before?.halted !== true) {
    changes.push({
      level: 'error',
      event: 'v2_loss_budget_halt',
      message: `${bookId}: loss budget halts entries, ${loss}`,
    });
  } else if (after.sizeMultiplier < (before?.sizeMultiplier ?? 1)) {
    changes.push({
      level: 'warn',
      event: 'v2_loss_budget_step',
      message: `${bookId}: entries sized at ${after.sizeMultiplier}x, ${loss}`,
    });
  }
  if (after.entriesBlockedAtNextFill && !after.halted) {
    changes.push({
      level: 'warn',
      event: 'v2_daily_loss_cap',
      message: `${bookId}: daily loss cap blocks new entries`,
    });
  }
  return changes;
}

type FilledLimitEntry = Extract<LimitEntryOutcome, { kind: 'filled' }>;

const SIZING_REFUSAL_PARAMETERS: Readonly<Record<string, string>> = {
  no_adv: 'ADV_WINDOW_COVERAGE',
  no_allocation: 'SLEEVE_MINIMUM_CAPITAL',
  insufficient_cash: 'GROSS_CASH_GATE',
  gross_cap: 'BOOK_GROSS_NOTIONAL_CAP',
  cfd_cost_model_unset: 'CFD_COST_MODEL',
  cfd_spread_model_unset: 'CFD_SPREAD_MODEL',
  cfd_financing_model_unset: 'CFD_FINANCING_MODEL',
  cfd_borrow_model_unset: 'CFD_BORROW_MODEL',
  cfd_resting_stop_unverified: 'CFD_RESTING_STOP_VERIFIED',
  fx_year_start_stale: 'FX_YEAR_START_COVERAGE',
  short_requires_cfd: 'CFD_VENUE_ROUTE',
  long_on_cfd: 'CFD_VENUE_ROUTE',
};

const SIZING_REFUSAL_TICKETS: Readonly<Record<string, string>> = {
  fx_year_start_stale: '#2009',
};

function recordRefusal(
  deps: CycleDeps,
  tradingDate: string,
  refusals: string[],
  refusal: { scope: string; parameter: string; ticket: string; message: string },
): void {
  deps.journal.recordRefusal({ trading_date: tradingDate, ...refusal });
  refusals.push(refusal.message);
}

function recordFxRefusal(deps: CycleDeps, tradingDate: string, refusals: string[]): void {
  const message = deps.risk.fxRefusal(tradingDate);
  if (message === undefined) return;
  recordRefusal(deps, tradingDate, refusals, {
    scope: 'data',
    parameter: 'FX_YEAR_START_COVERAGE',
    ticket: '#2009',
    message,
  });
  deps.logger?.log({
    trace_id: `v2-${tradingDate}`,
    stage: 'v2',
    level: 'error',
    event: 'v2_fx_year_start_stale',
    message,
  });
}

function cycleRefusals(deps: CycleDeps, tradingDate: string, macro: MacroGateVerdict): string[] {
  const refusals: string[] = [];
  for (const parameter of CYCLE_LEVEL_PARAMETERS) {
    if (isSet(parameter)) continue;
    const { message } = new UnsetParameterError(parameter.name, parameter.ticket);
    recordRefusal(deps, tradingDate, refusals, {
      scope: 'parameter',
      parameter: parameter.name,
      ticket: parameter.ticket,
      message,
    });
  }
  const capital = deps.risk.capitalRefusal(tradingDate);
  if (capital !== undefined) {
    recordRefusal(deps, tradingDate, refusals, {
      scope: 'capital',
      parameter: 'CAPITAL_CONFIG',
      ticket: 'docs/research/66-v2-grill-decisions.md D8',
      message: capital,
    });
  }
  recordFxRefusal(deps, tradingDate, refusals);
  if (!isFresh(deps.market.lastBarBefore(CALENDAR_REFERENCE, tradingDate), tradingDate)) {
    recordRefusal(deps, tradingDate, refusals, {
      scope: 'data',
      parameter: 'CALENDAR_REFERENCE',
      ticket: '#1791',
      message: `${CALENDAR_REFERENCE} has no bar in the ${MAX_BAR_AGE_CALENDAR_DAYS} days before ${tradingDate}: every windowed read fails closed (postmortem §2)`,
    });
  }
  if (!macro.covered) {
    recordRefusal(deps, tradingDate, refusals, {
      scope: 'macro',
      parameter: 'MACRO_CALENDARS',
      ticket: 'docs/specs/debate-sleeve-spec.md §6',
      message: macro.reason,
    });
  }
  return refusals;
}

function skippedReport(deps: CycleDeps, tradingDate: string, macro: MacroGateVerdict): CycleReport {
  const message = `cycle ${tradingDate} already marked: skipped`;
  deps.journal.recordRefusal({
    trading_date: tradingDate,
    scope: 'cycle',
    parameter: 'TRADING_DATE',
    ticket: 'docs/specs/debate-sleeve-spec.md §10',
    message,
  });
  return {
    trading_date: tradingDate,
    dry_run: deps.dryRun,
    skipped: true,
    macro,
    sleeves: deps.registry.ids(),
    decisions: 0,
    entries: 0,
    exits: 0,
    fills: 0,
    submitted_orders: 0,
    simulated_orders: 0,
    dry_run_refusals: 0,
    rejected_orders: 0,
    refusals: [message],
    books: [],
  };
}

const NO_SLEEVE_OUTPUT = { decisions: [], refusals: [] } as const;

async function decideUnlessRefused(
  deps: CycleDeps,
  sleeve: Sleeve,
  tradingDate: string,
  macro: MacroGateVerdict,
): Promise<SleeveOutput> {
  if (!deps.dryRun && deps.risk.capitalRefusal(tradingDate) !== undefined) return NO_SLEEVE_OUTPUT;
  const allocation = deps.risk.allocationRefusal(sleeve, tradingDate);
  if (allocation !== undefined) {
    return {
      decisions: [],
      refusals: [
        {
          scope: 'allocation',
          parameter: 'SLEEVE_MINIMUM_CAPITAL',
          ticket: 'docs/research/66-v2-grill-decisions.md D8',
          message: allocation,
        },
      ],
    };
  }
  const context = { tradingDate, macroDay: macro.macroDay, dryRun: deps.dryRun };
  const universe = sleeve.universe(context);
  const output = await sleeve.decide(context, universe.instruments);
  return {
    decisions: output.decisions,
    refusals: [...universe.refusals, ...output.refusals],
  };
}

function controlRefusals(deps: CycleDeps, tradingDate: string, control: ManualControl): string[] {
  if (control.state === 'running') return [];
  const effect =
    control.state === 'halted'
      ? 'no sleeve decides and every open position is exited'
      : 'no sleeve decides; exits and resting stops run';
  const action = control.state === 'halted' ? 'halt' : 'pause';
  const message = `manual ${action} since ${control.setAt} (${control.reason}): ${effect}`;
  deps.journal.recordRefusal({
    trading_date: tradingDate,
    scope: 'control',
    parameter: 'MANUAL_CONTROL',
    ticket: CONTROL_TICKET,
    message,
  });
  return [message];
}

export async function runCycle(deps: CycleDeps, tradingDate: string): Promise<CycleReport> {
  const macro = macroGate(tradingDate);
  const report = deps.books.isMarked(tradingDate)
    ? skippedReport(deps, tradingDate, macro)
    : await runUnmarked(deps, tradingDate, macro);
  deps.logger?.log({
    trace_id: `v2-${tradingDate}`,
    stage: 'v2',
    level: 'info',
    event: 'v2_cycle_complete',
    message: `v2 cycle ${tradingDate}: ${report.decisions} decisions, ${report.submitted_orders} submitted`,
    payload: report,
  });
  return report;
}

interface SyncStep extends ThrowFailure {
  readonly run: (cycle: Cycle) => unknown;
}

// fillSimulatedEntries is not a guarded step: a fill quote error must stop the cycle (#1849)
const syncSteps = (): readonly SyncStep[] => [
  {
    event: 'v2_pending_resolve_threw',
    what: 'pending order resolve',
    run: (cycle) => cycle.resolvePendingOrders(),
  },
  { event: 'v2_fill_sweep_threw', what: 'fill sweep', run: (cycle) => cycle.sweepFills() },
  {
    event: 'v2_split_rescale_threw',
    what: 'split rescale',
    run: (cycle) => cycle.rescaleSplitPositions(),
  },
  {
    event: 'v2_entry_cancel_threw',
    what: 'cancel of entries blocked at the last mark',
    run: (cycle) => cycle.cancelEntriesBlockedAtLastMark(),
  },
];

async function syncStepThrows(cycle: Cycle): Promise<StepThrow[]> {
  const thrown: StepThrow[] = [];
  for (const step of syncSteps()) {
    try {
      await step.run(cycle);
    } catch (error) {
      thrown.push({ failure: step, error });
    }
  }
  return thrown;
}

async function syncBooksThenReconcile(
  deps: CycleDeps,
  cycle: Cycle,
  tradingDate: string,
): Promise<ReconcileOutcome> {
  const thrown = await syncStepThrows(cycle);
  cycle.fillSimulatedEntries();
  cycle.fillSimulatedExits();
  await readBrokerCashActivities(deps, tradingDate);
  if (thrown.length === 0) return reconcileOrBlockEntries(deps, tradingDate);
  return blockEntriesOnThrows(deps, tradingDate, thrown);
}

// The date stays unmarked for a retry rather than marked on books missing this cycle's fills
async function sweepFillsBeforeMarks(
  deps: CycleDeps,
  cycle: Cycle,
  tradingDate: string,
): Promise<void> {
  try {
    await cycle.sweepFills();
  } catch (error) {
    blockEntriesOnThrow(
      deps,
      tradingDate,
      { event: 'v2_fill_sweep_threw', what: 'fill sweep before the marks' },
      error,
    );
    throw error;
  }
}

async function tradeSleeveBooks(
  deps: CycleDeps,
  cycle: Cycle,
  sleeve: Sleeve,
  decisions: readonly SleeveDecision[],
): Promise<BookSpec[]> {
  const books = deps.books.forSleeve(sleeve.id);
  for (const book of books) {
    await cycle.cancelStaleEntries(book);
    await cycle.exits(book, decisions);
    await cycle.entries(book, cycle.withoutSittingOut(book, decisions));
  }
  return [...books];
}

async function runUnmarked(
  deps: CycleDeps,
  tradingDate: string,
  macro: MacroGateVerdict,
): Promise<CycleReport> {
  const control = deps.controls.current();
  const refusals = [
    ...cycleRefusals(deps, tradingDate, macro),
    ...controlRefusals(deps, tradingDate, control),
  ];
  const cycle = new Cycle(deps, tradingDate, macro, control);
  const reconciled = await syncBooksThenReconcile(deps, cycle, tradingDate);
  cycle.blockEntries(reconciled);
  await cycle.replaceStaleStops(reconciled.staleStops ?? []);
  const books: BookSpec[] = [];
  let decisionCount = 0;
  for (const sleeve of deps.registry.list()) {
    const output =
      control.state === 'running'
        ? await decideUnlessRefused(deps, sleeve, tradingDate, macro)
        : NO_SLEEVE_OUTPUT;
    decisionCount += output.decisions.length;
    for (const refusal of output.refusals) {
      deps.journal.recordRefusal({ trading_date: tradingDate, ...refusal });
      refusals.push(`${refusal.parameter}: ${refusal.message}`);
    }
    books.push(...(await tradeSleeveBooks(deps, cycle, sleeve, output.decisions)));
  }
  await sweepFillsBeforeMarks(deps, cycle, tradingDate);
  cycle.refuseMarkIfRescaleThrew();
  const bookReports = await cycle.markAll(books);
  refusals.push(...cycle.refusals);
  const { tally } = cycle;
  return {
    trading_date: tradingDate,
    dry_run: deps.dryRun,
    skipped: false,
    macro,
    sleeves: deps.registry.ids(),
    decisions: decisionCount,
    entries: tally.entries,
    exits: tally.exits,
    fills: tally.fills,
    submitted_orders: tally.submitted,
    simulated_orders: tally.simulated,
    dry_run_refusals: tally.refused,
    rejected_orders: tally.rejected,
    refusals,
    books: bookReports,
  };
}

export interface EntryPass {
  readonly tradingDate: string;
  readonly sleeveId: string;
  readonly decisionsFor: (book: BookSpec) => readonly SleeveDecision[];
  readonly entryOrderId: EntryOrderId;
  readonly blockedBookIds: ReadonlySet<string>;
}

export interface EntryPassReport {
  readonly entries: number;
  readonly submitted_orders: number;
  readonly simulated_orders: number;
  readonly dry_run_refusals: number;
  readonly rejected_orders: number;
  readonly refusals: readonly string[];
}

// Entries only: fills, reconcile, exits and marks stay with the daily cycle, which holds the run
// lease against this pass
export async function runEntryPass(deps: CycleDeps, pass: EntryPass): Promise<EntryPassReport> {
  const cycle = new Cycle(
    deps,
    pass.tradingDate,
    macroGate(pass.tradingDate),
    deps.controls.current(),
    pass.entryOrderId,
  );
  cycle.blockEntries({ blockedBookIds: pass.blockedBookIds, refusals: [] });
  for (const book of deps.books.forSleeve(pass.sleeveId)) {
    await cycle.entries(book, pass.decisionsFor(book));
  }
  const { tally } = cycle;
  return {
    entries: tally.entries,
    submitted_orders: tally.submitted,
    simulated_orders: tally.simulated,
    dry_run_refusals: tally.refused,
    rejected_orders: tally.rejected,
    refusals: cycle.refusals,
  };
}

export interface FlattenPassReport {
  readonly cancelled: number;
  readonly exits: number;
  readonly submitted_orders: number;
  readonly simulated_orders: number;
  readonly dry_run_refusals: number;
  readonly rejected_orders: number;
  readonly refusals: readonly string[];
}

// Out of cycle (#1894): every resting entry is cancelled before the sweep, so an entry that fills
// meanwhile is booked by it and closed by the halt exits below rather than left open
export async function runFlattenPass(
  deps: CycleDeps,
  tradingDate: string,
): Promise<FlattenPassReport> {
  const cycle = new Cycle(deps, tradingDate, macroGate(tradingDate), deps.controls.current());
  const books = deps.registry.ids().flatMap((sleeveId) => [...deps.books.forSleeve(sleeveId)]);
  let cancelled = 0;
  for (const book of books) {
    cancelled += await cycle.cancelEntries(
      book,
      deps.journal.restingEntries(book.id),
      'exit',
      deps.journal.partFilledEntries(book.id),
    );
  }
  await cycle.sweepFills();
  for (const book of books) await cycle.haltExits(book);
  const { tally } = cycle;
  return {
    cancelled,
    exits: tally.exits,
    submitted_orders: tally.submitted,
    simulated_orders: tally.simulated,
    dry_run_refusals: tally.refused,
    rejected_orders: tally.rejected,
    refusals: cycle.refusals,
  };
}
