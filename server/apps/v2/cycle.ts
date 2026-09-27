import type {
  BookLedger,
  BookSpec,
  ControlReader,
  DecisionJournal,
  EntryApproval,
  JournalledOrder,
  LossBudgetState,
  ManualControl,
  MarketData,
  OrderExecutor,
  OrderOutcome,
  OrderSide,
  Position,
  RiskGate,
  Sleeve,
  SleeveDecision,
  SleeveOutput,
  SleeveSource,
  Submission,
  V2Bar,
  V2Fill,
  Venue,
} from '../../../contracts/index.js';
import type { Clock, Logger } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import {
  CALENDAR_REFERENCE,
  isFresh,
  MAX_BAR_AGE_CALENDAR_DAYS,
  type MacroGateVerdict,
  macroGate,
  quotePerGbp,
} from './data/index.js';
import { CYCLE_LEVEL_PARAMETERS, isSet, UnsetParameterError } from './signal/index.js';
import { simulateLimitEntry, simulateMarketExit } from './simulated-entry.js';

export interface CycleDeps {
  readonly registry: SleeveSource;
  readonly books: BookLedger;
  readonly journal: DecisionJournal;
  readonly risk: RiskGate;
  readonly executor: OrderExecutor;
  readonly controls: ControlReader;
  readonly market: MarketData;
  readonly clock: Clock;
  readonly dryRun: boolean;
  readonly logger?: Logger | undefined;
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

function stopTouched(held: Position, lowGbp: number, highGbp: number): boolean {
  if (held.stopGbp === undefined) return false;
  return held.qty > 0 ? lowGbp <= held.stopGbp : highGbp >= held.stopGbp;
}

function targetTouched(held: Position, lowGbp: number, highGbp: number): boolean {
  if (held.targetGbp === undefined) return false;
  return held.qty > 0 ? highGbp >= held.targetGbp : lowGbp <= held.targetGbp;
}

interface BracketExit {
  readonly priceGbp: number | undefined;
  readonly crossesSpread: boolean;
}

function bracketExit(held: Position, lowGbp: number, highGbp: number): BracketExit | undefined {
  if (stopTouched(held, lowGbp, highGbp)) return { priceGbp: held.stopGbp, crossesSpread: true };
  if (targetTouched(held, lowGbp, highGbp)) {
    return { priceGbp: held.targetGbp, crossesSpread: false };
  }
  return undefined;
}

function opposite(side: OrderSide): OrderSide {
  return side === 'buy' ? 'sell' : 'buy';
}

// A resting-order sign flip (via a failed cancel, #1778) or a broker double-fill on an
// already-closed bracket leg both land here as "unexpected" whether or not the fill's own
// leg is 'entry' — only a fresh open from flat, by an entry-leg fill, is the normal case
function crossedUnexpectedly(leg: V2Fill['leg'], beforeQty: number, afterQty: number): boolean {
  const beforeSign = Math.sign(beforeQty);
  const afterSign = Math.sign(afterQty);
  if (beforeSign !== 0 && afterSign !== 0) return beforeSign !== afterSign;
  return beforeSign === 0 && afterSign !== 0 && leg !== 'entry';
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

type ExitReason = 'time_stop' | 'manual_halt';

const CONTROL_TICKET = 'docs/specs/dashboard-spec.md §5';

function positionKey(bookId: string, instrument: string): string {
  return `${bookId}|${instrument}`;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function withinLimit(side: OrderSide, limit: number, price: number): number {
  return side === 'buy' ? Math.min(limit, price) : Math.max(limit, price);
}

const SIMULATED_OUTCOMES: ReadonlySet<OrderOutcome> = new Set(['simulated', 'refused_dry_run']);

class Cycle {
  readonly refusals: string[] = [];
  readonly #pendingEntries = new Set<string>();
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
  ) {}

  fxFor(venue: Venue): number {
    return quotePerGbp(this.deps.market, venue, this.tradingDate);
  }

  markGbp(instrument: string, venue: Venue): number | undefined {
    const bar = this.deps.market.lastBarBefore(instrument, this.tradingDate);
    return bar === undefined ? undefined : bar.rawClose / this.fxFor(venue);
  }

  async sweepFills(): Promise<void> {
    const sweep = await this.deps.executor.fetchNewFills(this.since());
    for (const failure of sweep.failures) this.log('warn', 'v2_fill_sweep_failed', failure);
    for (const fill of sweep.fills) this.ingest(fill);
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
    const side = fill.leg === 'entry' || order.leg === 'exit' ? order.side : opposite(order.side);
    const fx = this.fxFor(order.venue as Venue);
    const priceGbp = fill.price / fx;
    const recorded = this.deps.journal.recordFill({
      fill_id: `${order.venue}:${fill.broker_fill_id}`,
      client_order_id: order.client_order_id,
      book_id: order.book_id,
      trading_date: this.tradingDate,
      instrument: order.instrument,
      venue: order.venue,
      leg: fill.leg,
      side,
      qty: fill.qty,
      price_gbp: priceGbp,
      fee_gbp: fill.fee / fx,
    });
    if (!recorded) return;
    this.tally.fills += 1;
    const { stopGbp, targetGbp } = bracketLevelsGbp(fill, order, fx);
    const before = this.deps.books.position(order.book_id, order.instrument);
    const after = this.deps.books.applyFill(order.book_id, {
      instrument: order.instrument,
      venue: order.venue as Venue,
      side,
      qty: fill.qty,
      priceGbp,
      feeGbp: fill.fee / fx,
      clientOrderId: order.client_order_id,
      tradingDate: this.tradingDate,
      stopGbp,
      targetGbp,
    });
    this.warnIfFillCrossedFlat(order, fill.leg, before, after);
  }

  warnIfFillCrossedFlat(
    order: JournalledOrder,
    leg: V2Fill['leg'],
    before: Position | undefined,
    after: Position | undefined,
  ): void {
    if (after === undefined || !crossedUnexpectedly(leg, before?.qty ?? 0, after.qty)) return;
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
    });
    this.refusals.push(message);
  }

  fillSimulatedEntries(): void {
    for (const order of this.deps.journal.unfilledSimulatedEntriesBefore(this.tradingDate)) {
      this.fillSimulatedEntry(order);
    }
  }

  fillSimulatedEntry(order: JournalledOrder): void {
    const limit = order.payload.price as number;
    const side = order.side as OrderSide;
    const daysOpen = calendarDaysBetween(order.trading_date, this.tradingDate);
    const outcome = simulateLimitEntry(
      { side, limit, stop: numberOrUndefined(order.payload.stop) },
      this.barsSince(order),
    );
    if (outcome.kind === 'pending' && daysOpen <= MAX_PENDING_CALENDAR_DAYS) {
      this.#pendingEntries.add(positionKey(order.book_id, order.instrument));
      return;
    }
    if (outcome.kind !== 'filled') {
      this.deps.journal.markCancelled(order.client_order_id, this.tradingDate);
      return;
    }
    const qty = order.payload.size as number;
    const quote = this.deps.executor.quoteSimulatedFill(order.venue as Venue, {
      instrument: order.instrument,
      side,
      qty,
      price: outcome.price,
      crossesSpread: outcome.crossesSpread,
    });
    this.ingest({
      client_order_id: order.client_order_id,
      broker_fill_id: `sim-${order.client_order_id}`,
      leg: 'entry',
      price: withinLimit(side, limit, quote.price),
      qty,
      fee: quote.fee,
    });
    const held = this.deps.books.position(order.book_id, order.instrument);
    if (outcome.stoppedAt !== undefined && held !== undefined) {
      this.simulatedExit(order.book_id, held, outcome.stoppedAt, true, 'stop_on_entry_bar');
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
      for (const held of this.deps.books.positions(bookId)) this.fillSimulatedExit(held);
    }
  }

  fillSimulatedExit(held: Position): void {
    if (held.exitClientOrderId === undefined) return;
    const order = this.deps.journal.orderFor(held.exitClientOrderId);
    if (order === undefined || !SIMULATED_OUTCOMES.has(order.outcome)) return;
    const price = simulateMarketExit(this.barsSince(order));
    if (price === undefined) {
      this.warnIfStale(order);
      return;
    }
    const qty = Math.abs(held.qty);
    const quote = this.deps.executor.quoteSimulatedFill(held.venue, {
      instrument: held.instrument,
      side: order.side,
      qty,
      price,
      crossesSpread: true,
    });
    this.ingest({
      client_order_id: order.client_order_id,
      broker_fill_id: `sim-${order.client_order_id}`,
      leg: 'exit',
      price: quote.price,
      qty,
      fee: quote.fee,
    });
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
    await this.cancelEntries(
      book,
      this.deps.journal.unfilledEntriesBefore(book.id, this.tradingDate),
    );
  }

  async cancelEntries(book: BookSpec, orders: readonly JournalledOrder[]): Promise<number> {
    let cancelled = 0;
    for (const order of orders) {
      const route = routeOf(book, order.venue as Venue);
      if (!this.deps.executor.canRoute(route)) continue;
      try {
        await this.deps.executor.cancel(route, order.client_order_id, order.instrument);
        this.deps.journal.markCancelled(order.client_order_id, this.tradingDate);
        cancelled += 1;
      } catch (error) {
        // Still resting at the broker: block a fresh opposite entry here too, or its fill
        // could later cross the stale one's fill and flip the position unnoticed (#1778)
        this.#pendingEntries.add(positionKey(book.id, order.instrument));
        this.log(
          'warn',
          'v2_cancel_failed',
          `${order.client_order_id}: ${describeThrownSafely(error)}`,
        );
      }
    }
    return cancelled;
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
    const cancelled = await this.cancelEntries(book, this.deps.journal.restingEntries(book.id));
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
    const exit = bracketExit(held, bar.low * toRawGbp, bar.high * toRawGbp);
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
    const quote = this.deps.executor.quoteSimulatedFill(held.venue, {
      instrument: held.instrument,
      side,
      qty: Math.abs(held.qty),
      price: trigger,
      crossesSpread,
    });
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
      if (held.exitClientOrderId !== undefined) continue;
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
    const order = this.deps.risk.approveExit({ book, held, clientOrderId });
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
        marks_held: held.marksHeld,
        reason,
        approval: submission.approvalId,
      },
    });
    if (submission.outcome !== 'rejected') {
      this.deps.books.setExitPending(book.id, held.instrument, clientOrderId);
    }
  }

  count(outcome: OrderOutcome): void {
    if (outcome === 'submitted') this.tally.submitted += 1;
    else if (outcome === 'refused_dry_run') this.tally.refused += 1;
    else if (outcome === 'simulated') this.tally.simulated += 1;
    else this.tally.rejected += 1;
  }

  async resumePendingExit(book: BookSpec, held: Position): Promise<void> {
    if (held.exitClientOrderId === undefined) return;
    try {
      await this.deps.executor.resumeFlatten(
        routeOf(book, held.venue),
        held.exitClientOrderId,
        held.instrument,
      );
    } catch (error) {
      this.log('warn', 'v2_resume_flatten_failed', describeThrownSafely(error));
    }
  }

  async exits(book: BookSpec): Promise<void> {
    for (const held of this.deps.books.positions(book.id)) {
      await this.resumePendingExit(book, held);
      if (this.deps.executor.simulates(routeOf(book, held.venue))) {
        this.simulatedBracketExit(book, held);
      }
      const stillHeld = this.deps.books.position(book.id, held.instrument);
      if (stillHeld !== undefined) await this.timeStop(book, stillHeld);
    }
    if (this.control.state === 'halted') await this.haltExits(book);
  }

  entryOrderId(book: BookSpec, instrument: string): string {
    return `v2-${book.id.replaceAll('/', '-')}-${this.tradingDate}-${instrument}`;
  }

  async submitEntry(
    book: BookSpec,
    decision: SleeveDecision,
    decisionId: string,
    approval: EntryApproval,
  ): Promise<void> {
    const clientOrderId = this.entryOrderId(book, decision.instrument);
    if (this.deps.journal.orderFor(clientOrderId) !== undefined) return;
    if (this.deps.books.position(book.id, decision.instrument) !== undefined) return;
    if (this.#pendingEntries.has(positionKey(book.id, decision.instrument))) return;
    this.tally.entries += 1;
    const submission: Submission =
      approval.order === undefined
        ? { outcome: 'rejected', detail: approval.refusal, approvalId: '' }
        : await this.deps.executor.submit(approval.order);
    this.count(submission.outcome);
    this.deps.journal.recordOrder({
      client_order_id: clientOrderId,
      decision_id: decisionId,
      book_id: book.id,
      trading_date: this.tradingDate,
      instrument: decision.instrument,
      venue: decision.venue,
      leg: 'entry',
      side: decision.action === 'enter_short' ? 'sell' : 'buy',
      dry_run: this.deps.dryRun,
      outcome: submission.outcome,
      payload: {
        size: approval.size,
        detail: submission.detail,
        price: decision.price,
        stop: decision.stop_price,
        target: approval.order?.kind === 'bracket_entry' ? approval.order.target : undefined,
        approval: approval.order === undefined ? undefined : submission.approvalId,
      },
    });
  }

  async entries(book: BookSpec, decisions: readonly SleeveDecision[]): Promise<void> {
    const { equityGbp } = this.deps.books.valuation(book.id, (i, v) => this.markGbp(i, v));
    for (const proposed of decisions) {
      const decision = vetoApplied(book, proposed);
      const approval = this.deps.risk.approveEntry({
        book,
        decision,
        clientOrderId: this.entryOrderId(book, decision.instrument),
        tradingDate: this.tradingDate,
        equityGbp,
        macroDay: this.macro.macroDay,
      });
      const decisionId = this.deps.journal.recordDecision(
        book.id,
        this.tradingDate,
        decision,
        approval.size,
      );
      if (approval.order === undefined) this.journalSizingRefusal(book, decision, approval.refusal);
      if (approval.size > 0) await this.submitEntry(book, decision, decisionId, approval);
    }
  }

  journalSizingRefusal(book: BookSpec, decision: SleeveDecision, refusal?: string): void {
    const parameter = SIZING_REFUSAL_PARAMETERS[refusal ?? ''];
    if (parameter === undefined) return;
    this.deps.journal.recordRefusal({
      trading_date: this.tradingDate,
      scope: 'entry',
      parameter,
      ticket: 'docs/research/66-v2-grill-decisions.md D8',
      message: `${book.id} ${decision.instrument}: ${refusal}`,
      book_id: book.id,
      instrument: decision.instrument,
    });
  }

  async markAll(books: readonly BookSpec[]): Promise<BookReport[]> {
    const reports: BookReport[] = [];
    for (const book of books) reports.push(await this.mark(book));
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

  async mark(book: BookSpec): Promise<BookReport> {
    this.journalStaleMarks(book);
    const previous = this.deps.books.lastDay(book.id);
    const day = this.deps.books.markDay(
      book.id,
      this.tradingDate,
      (i, v) => this.markGbp(i, v),
      calendarDaysBetween(previous?.tradingDate, this.tradingDate),
    );
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

const SIZING_REFUSAL_PARAMETERS: Readonly<Record<string, string>> = {
  no_adv: 'ADV_WINDOW_COVERAGE',
  no_allocation: 'SLEEVE_MINIMUM_CAPITAL',
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
  await cycle.sweepFills();
  await cycle.cancelEntriesBlockedAtLastMark();
  cycle.fillSimulatedEntries();
  cycle.fillSimulatedExits();
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
    for (const book of deps.books.forSleeve(sleeve.id)) {
      books.push(book);
      await cycle.cancelStaleEntries(book);
      await cycle.exits(book);
      await cycle.entries(book, output.decisions);
    }
  }
  await cycle.sweepFills();
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
