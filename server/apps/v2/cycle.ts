import type { BrokerAdapter, NormalizedFill } from '../../pipeline/execution/index.js';
import type { DailyBar } from '../../pipeline/momentum/index.js';
import type { Clock, Logger } from '../../shared/index.js';
import { describeThrownSafely, toBrokerFillId } from '../../shared/index.js';
import type { BookSpec, PaperBooks, Position } from './books.js';
import { DryRunRefusedError } from './dry-run-broker.js';
import type { Journal, OrderOutcome, OrderSide } from './journal.js';
import { type MacroGateVerdict, macroGate } from './macro-calendar.js';
import { CYCLE_LEVEL_PARAMETERS, isSet, UnsetParameterError } from './parameters.js';
import { positionSizeShares } from './position-size.js';
import type { SleeveDecision, SleeveRegistry, Venue } from './sleeve.js';

export interface CycleDeps {
  readonly registry: SleeveRegistry;
  readonly books: PaperBooks;
  readonly journal: Journal;
  readonly brokers: Partial<Readonly<Record<Venue, BrokerAdapter>>>;
  readonly simulatedBroker: BrokerAdapter;
  readonly bar: (instrument: string, tradingDate: string) => DailyBar | undefined;
  readonly gbpUsdAtYearStart: number;
  readonly riskFraction: number;
  readonly targetAtrMultiple: number;
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
const EPOCH = new Date(0);

export function calendarDaysBetween(from: string | undefined, to: string): number {
  if (from === undefined) return 0;
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY));
}

function bracketExitGbp(held: Position, lowGbp: number, highGbp: number): number | undefined {
  const long = held.qty > 0;
  if (held.stopGbp !== undefined && (long ? lowGbp <= held.stopGbp : highGbp >= held.stopGbp)) {
    return held.stopGbp;
  }
  if (
    held.targetGbp !== undefined &&
    (long ? highGbp >= held.targetGbp : lowGbp <= held.targetGbp)
  ) {
    return held.targetGbp;
  }
  return undefined;
}

function opposite(side: OrderSide): OrderSide {
  return side === 'buy' ? 'sell' : 'buy';
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
    return venue === 'alpaca' ? this.deps.gbpUsdAtYearStart : 1;
  }

  markGbp(instrument: string, venue: Venue): number | undefined {
    const bar = this.deps.bar(instrument, this.tradingDate);
    return bar === undefined ? undefined : bar.rawClose / this.fxFor(venue);
  }

  simulated(book: BookSpec): boolean {
    return this.deps.dryRun || book.variant !== 'primary';
  }

  brokerFor(book: BookSpec, venue: Venue): BrokerAdapter | undefined {
    return this.simulated(book) ? this.deps.simulatedBroker : this.deps.brokers[venue];
  }

  brokers(): readonly BrokerAdapter[] {
    const all = new Set<BrokerAdapter>([this.deps.simulatedBroker]);
    if (!this.deps.dryRun) {
      for (const broker of Object.values(this.deps.brokers)) all.add(broker);
    }
    return [...all];
  }

  async sweepFills(): Promise<void> {
    for (const broker of this.brokers()) {
      let fills: NormalizedFill[];
      try {
        fills = await broker.fetchNewFills(this.since());
      } catch (error) {
        this.log('warn', 'v2_fill_sweep_failed', describeThrownSafely(error));
        continue;
      }
      for (const fill of fills) this.ingest(fill);
    }
  }

  since(): Date {
    let earliest: string | undefined;
    for (const bookId of this.deps.books.ids()) {
      const recordedAt = this.deps.books.lastDay(bookId)?.recordedAt;
      if (recordedAt !== undefined && (earliest === undefined || recordedAt < earliest)) {
        earliest = recordedAt;
      }
    }
    return earliest === undefined ? EPOCH : new Date(earliest);
  }

  ingest(fill: NormalizedFill): void {
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
      const broker = this.brokerFor(book, order.venue as Venue);
      if (broker === undefined) continue;
      try {
        await broker.cancel(order.client_order_id, order.instrument);
        this.deps.journal.markCancelled(order.client_order_id, this.tradingDate);
      } catch (error) {
        this.log('warn', 'v2_cancel_failed', describeThrownSafely(error));
      }
    }
  }

  simulatedBracketExit(book: BookSpec, held: Position): void {
    const bar = this.deps.bar(held.instrument, this.tradingDate);
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
      broker_fill_id: toBrokerFillId(`sim-${clientOrderId}`),
      leg: 'exit',
      price: exitGbp * fx,
      qty: Math.abs(held.qty),
      fee: 0,
      timestamp: this.deps.clock.now(),
    });
  }

  exitOrderId(book: BookSpec, instrument: string): string {
    return `v2-${book.id.replaceAll('/', '-')}-${this.tradingDate}-${instrument}-exit`;
  }

  async timeStop(book: BookSpec, held: Position): Promise<void> {
    if (held.marksHeld < this.deps.timeStopTradingDays || held.exitClientOrderId !== undefined) {
      return;
    }
    const broker = this.brokerFor(book, held.venue);
    const side: OrderSide = held.qty > 0 ? 'sell' : 'buy';
    const clientOrderId = this.exitOrderId(book, held.instrument);
    if (broker === undefined || this.deps.journal.orderFor(clientOrderId) !== undefined) return;
    this.tally.exits += 1;
    let outcome: OrderOutcome;
    let detail: string;
    try {
      const ack = await broker.submitFlatten(
        held.instrument,
        side,
        Math.abs(held.qty),
        clientOrderId,
      );
      outcome = 'submitted';
      detail = ack.order_state;
    } catch (error) {
      ({ outcome, detail } = this.failedSubmission(book, error));
    }
    this.count(outcome);
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
      outcome,
      payload: { size: Math.abs(held.qty), detail, marks_held: held.marksHeld },
    });
    if (outcome !== 'rejected')
      this.deps.books.setExitPending(book.id, held.instrument, clientOrderId);
  }

  failedSubmission(book: BookSpec, error: unknown): { outcome: OrderOutcome; detail: string } {
    if (error instanceof DryRunRefusedError) {
      return {
        outcome: book.variant === 'primary' ? 'refused_dry_run' : 'simulated',
        detail: error.message,
      };
    }
    return { outcome: 'rejected', detail: describeThrownSafely(error) };
  }

  count(outcome: OrderOutcome): void {
    if (outcome === 'submitted') this.tally.submitted += 1;
    else if (outcome === 'refused_dry_run') this.tally.refused += 1;
    else if (outcome === 'simulated') this.tally.simulated += 1;
    else this.tally.rejected += 1;
  }

  async resumePendingExit(book: BookSpec, held: Position): Promise<void> {
    if (held.exitClientOrderId === undefined || this.simulated(book)) return;
    const broker = this.brokerFor(book, held.venue);
    try {
      await broker?.resumeFlatten(held.exitClientOrderId, held.instrument);
    } catch (error) {
      this.log('warn', 'v2_resume_flatten_failed', describeThrownSafely(error));
    }
  }

  async exits(book: BookSpec): Promise<void> {
    for (const held of this.deps.books.positions(book.id)) {
      await this.resumePendingExit(book, held);
      if (this.simulated(book)) this.simulatedBracketExit(book, held);
      const stillHeld = this.deps.books.position(book.id, held.instrument);
      if (stillHeld !== undefined) await this.timeStop(book, stillHeld);
    }
  }

  sizeFor(book: BookSpec, decision: SleeveDecision, equityGbp: number): number {
    if (decision.action !== 'enter_long' && decision.action !== 'enter_short') return 0;
    const previous = this.deps.books.lastDay(book.id)?.state;
    let multiplier = previous?.sizeMultiplier ?? 1;
    if (previous?.entriesBlockedAtNextFill === true) multiplier = 0;
    const fx = this.fxFor(decision.venue);
    return positionSizeShares({
      equityGbp,
      riskFraction: this.deps.riskFraction,
      priceGbp: decision.price / fx,
      atrGbp: (decision.atr ?? 0) / fx,
      sizeMultiplier: multiplier,
      macroDay: book.variant === 'no-macro-gate' ? false : this.macro.macroDay,
    });
  }

  async submitEntry(
    book: BookSpec,
    decision: SleeveDecision,
    decisionId: string,
    size: number,
  ): Promise<void> {
    const clientOrderId = `v2-${book.id.replaceAll('/', '-')}-${this.tradingDate}-${decision.instrument}`;
    if (this.deps.journal.orderFor(clientOrderId) !== undefined) return;
    if (this.deps.books.position(book.id, decision.instrument) !== undefined) return;
    this.tally.entries += 1;
    const side: OrderSide = decision.action === 'enter_short' ? 'sell' : 'buy';
    const stop = decision.stop_price;
    const atr = decision.atr;
    let outcome: OrderOutcome;
    let detail: string;
    let target: number | undefined;
    const broker = this.brokerFor(book, decision.venue);
    if (stop === undefined || atr === undefined) {
      ({ outcome, detail } = { outcome: 'rejected', detail: 'no_stop_price' });
    } else if (broker === undefined) {
      ({ outcome, detail } = {
        outcome: 'rejected',
        detail: `no_broker_for_venue:${decision.venue}`,
      });
    } else {
      const distance = this.deps.targetAtrMultiple * atr;
      target = side === 'sell' ? decision.price - distance : decision.price + distance;
      try {
        const ack = await broker.submitBracket({
          client_order_id: clientOrderId,
          instrument: decision.instrument,
          asset_class: 'stocks',
          side,
          size,
          entry: decision.price,
          stop,
          target,
          time_in_force: 'gtc',
        });
        outcome = 'submitted';
        detail = ack.order_state;
      } catch (error) {
        ({ outcome, detail } = this.failedSubmission(book, error));
      }
    }
    this.count(outcome);
    this.deps.journal.recordOrder({
      client_order_id: clientOrderId,
      decision_id: decisionId,
      book_id: book.id,
      trading_date: this.tradingDate,
      instrument: decision.instrument,
      venue: decision.venue,
      leg: 'entry',
      side,
      dry_run: this.deps.dryRun,
      outcome,
      payload: { size, detail, price: decision.price, stop, target },
    });
  }

  async entries(book: BookSpec, decisions: readonly SleeveDecision[]): Promise<void> {
    const { equityGbp } = this.deps.books.valuation(book.id, (i, v) => this.markGbp(i, v));
    for (const decision of decisions) {
      const size = this.sizeFor(book, decision, equityGbp);
      const decisionId = this.deps.journal.recordDecision(
        book.id,
        this.tradingDate,
        decision,
        size,
      );
      if (size > 0) await this.submitEntry(book, decision, decisionId, size);
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

function cycleRefusals(deps: CycleDeps, tradingDate: string, macro: MacroGateVerdict): string[] {
  const refusals: string[] = [];
  for (const parameter of CYCLE_LEVEL_PARAMETERS) {
    if (isSet(parameter)) continue;
    const { message } = new UnsetParameterError(parameter.name, parameter.ticket);
    deps.journal.recordRefusal({
      trading_date: tradingDate,
      scope: 'parameter',
      parameter: parameter.name,
      ticket: parameter.ticket,
      message,
    });
    refusals.push(message);
  }
  if (!macro.covered) {
    deps.journal.recordRefusal({
      trading_date: tradingDate,
      scope: 'macro',
      parameter: 'MACRO_CALENDARS',
      ticket: 'docs/specs/debate-sleeve-spec.md §6',
      message: macro.reason,
    });
    refusals.push(macro.reason);
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
  const cycle = new Cycle(deps, tradingDate, macro);
  await cycle.sweepFills();
  const books: BookSpec[] = [];
  let decisionCount = 0;
  for (const sleeve of deps.registry.list()) {
    const output = await sleeve.decide({
      tradingDate,
      macroDay: macro.macroDay,
      dryRun: deps.dryRun,
    });
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
