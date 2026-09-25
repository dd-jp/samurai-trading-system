import type {
  BookLedger,
  BookSpec,
  DecisionJournal,
  EntryApproval,
  MarketData,
  OrderExecutor,
  OrderOutcome,
  OrderSide,
  Position,
  RiskGate,
  SleeveDecision,
  SleeveSource,
  Submission,
  V2Fill,
  Venue,
} from '../../../contracts/index.js';
import type { Clock, Logger } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import { type MacroGateVerdict, macroGate, quotePerGbp } from './data/index.js';
import { CYCLE_LEVEL_PARAMETERS, isSet, UnsetParameterError } from './signal/index.js';

export interface CycleDeps {
  readonly registry: SleeveSource;
  readonly books: BookLedger;
  readonly journal: DecisionJournal;
  readonly risk: RiskGate;
  readonly executor: OrderExecutor;
  readonly market: MarketData;
  readonly timeStopTradingDays: number;
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

function bracketExitGbp(held: Position, lowGbp: number, highGbp: number): number | undefined {
  if (stopTouched(held, lowGbp, highGbp)) return held.stopGbp;
  if (targetTouched(held, lowGbp, highGbp)) return held.targetGbp;
  return undefined;
}

function opposite(side: OrderSide): OrderSide {
  return side === 'buy' ? 'sell' : 'buy';
}

function routeOf(book: BookSpec, venue: Venue) {
  return { bookVariant: book.variant, venue };
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

class Cycle {
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
    const stop = order.payload.stop;
    const target = order.payload.target;
    this.deps.books.applyFill(order.book_id, {
      instrument: order.instrument,
      venue: order.venue as Venue,
      side,
      qty: fill.qty,
      priceGbp,
      feeGbp: fill.fee / fx,
      clientOrderId: order.client_order_id,
      tradingDate: this.tradingDate,
      stopGbp: typeof stop === 'number' ? stop / fx : undefined,
      targetGbp: typeof target === 'number' ? target / fx : undefined,
    });
  }

  async cancelStaleEntries(book: BookSpec): Promise<void> {
    for (const order of this.deps.journal.unfilledEntriesBefore(book.id, this.tradingDate)) {
      const route = routeOf(book, order.venue as Venue);
      if (!this.deps.executor.canRoute(route)) continue;
      try {
        await this.deps.executor.cancel(route, order.client_order_id, order.instrument);
        this.deps.journal.markCancelled(order.client_order_id, this.tradingDate);
      } catch (error) {
        this.log('warn', 'v2_cancel_failed', describeThrownSafely(error));
      }
    }
  }

  simulatedBracketExit(book: BookSpec, held: Position): void {
    const bar = this.deps.market.lastBarBefore(held.instrument, this.tradingDate);
    if (bar === undefined || bar.date < held.openedDate) return;
    const fx = this.fxFor(held.venue);
    const exitGbp = bracketExitGbp(held, bar.low / fx, bar.high / fx);
    if (exitGbp === undefined) return;
    const side: OrderSide = held.qty > 0 ? 'sell' : 'buy';
    const clientOrderId = this.exitOrderId(book, held.instrument);
    if (this.deps.journal.orderFor(clientOrderId) !== undefined) return;
    this.tally.exits += 1;
    this.tally.simulated += 1;
    this.deps.journal.recordOrder({
      client_order_id: clientOrderId,
      decision_id: null,
      book_id: book.id,
      trading_date: this.tradingDate,
      instrument: held.instrument,
      venue: held.venue,
      leg: 'exit',
      side,
      dry_run: this.deps.dryRun,
      outcome: 'simulated',
      payload: {
        size: Math.abs(held.qty),
        detail: 'bracket_leg_on_daily_bar',
        price: exitGbp * fx,
      },
    });
    this.ingest({
      client_order_id: clientOrderId,
      broker_fill_id: `sim-${clientOrderId}`,
      leg: 'exit',
      price: exitGbp * fx,
      qty: Math.abs(held.qty),
      fee: 0,
    });
  }

  exitOrderId(book: BookSpec, instrument: string): string {
    return `v2-${book.id.replaceAll('/', '-')}-${this.tradingDate}-${instrument}-exit`;
  }

  async timeStop(book: BookSpec, held: Position): Promise<void> {
    if (held.marksHeld < this.deps.timeStopTradingDays || held.exitClientOrderId !== undefined) {
      return;
    }
    const clientOrderId = this.exitOrderId(book, held.instrument);
    if (
      !this.deps.executor.canRoute(routeOf(book, held.venue)) ||
      this.deps.journal.orderFor(clientOrderId) !== undefined
    ) {
      return;
    }
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
    for (const decision of decisions) {
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
      if (approval.size > 0) await this.submitEntry(book, decision, decisionId, approval);
    }
  }

  mark(book: BookSpec): BookReport {
    const previous = this.deps.books.lastDay(book.id);
    const day = this.deps.books.markDay(
      book.id,
      this.tradingDate,
      (i, v) => this.markGbp(i, v),
      calendarDaysBetween(previous?.tradingDate, this.tradingDate),
    );
    return {
      book_id: book.id,
      equity_gbp: day.equityGbp,
      cash_gbp: day.cashGbp,
      size_multiplier: day.state.entriesBlockedAtNextFill ? 0 : day.state.sizeMultiplier,
      positions: this.deps.books.positions(book.id).length,
    };
  }

  log(level: 'warn' | 'info', event: string, message: string): void {
    this.deps.logger?.log({
      trace_id: `v2-${this.tradingDate}`,
      stage: 'v2',
      level,
      event,
      message,
    });
  }
}

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
  const refusals = cycleRefusals(deps, tradingDate, macro);
  const entriesRefused = !deps.dryRun && deps.risk.capitalRefusal(tradingDate) !== undefined;
  const cycle = new Cycle(deps, tradingDate, macro);
  await cycle.sweepFills();
  const books: BookSpec[] = [];
  let decisionCount = 0;
  for (const sleeve of deps.registry.list()) {
    const output = entriesRefused
      ? NO_SLEEVE_OUTPUT
      : await sleeve.decide({ tradingDate, macroDay: macro.macroDay, dryRun: deps.dryRun });
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
    books: books.map((book) => cycle.mark(book)),
  };
}
