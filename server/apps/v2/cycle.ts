import type { BrokerAdapter } from '../../pipeline/execution/index.js';
import type { Clock, Logger } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import type { BookSpec, PaperBooks } from './books.js';
import { DryRunRefusedError } from './dry-run-broker.js';
import type { Journal, OrderOutcome } from './journal.js';
import { type MacroGateVerdict, macroGate } from './macro-calendar.js';
import { CYCLE_LEVEL_PARAMETERS, isSet, UnsetParameterError } from './parameters.js';
import { positionSizeShares } from './position-size.js';
import type { SleeveDecision, SleeveRegistry, Venue } from './sleeve.js';

export interface CycleDeps {
  readonly registry: SleeveRegistry;
  readonly books: PaperBooks;
  readonly journal: Journal;
  readonly brokers: Readonly<Record<Venue, BrokerAdapter>>;
  readonly gbpUsdAtYearStart: number;
  readonly riskFraction: number | undefined;
  readonly targetAtrMultiple: number | undefined;
  readonly clock: Clock;
  readonly dryRun: boolean;
  readonly logger?: Logger | undefined;
}

export interface CycleReport {
  readonly trading_date: string;
  readonly dry_run: boolean;
  readonly macro: MacroGateVerdict;
  readonly sleeves: readonly string[];
  readonly decisions: number;
  readonly entries: number;
  readonly submitted_orders: number;
  readonly dry_run_refusals: number;
  readonly rejected_orders: number;
  readonly refusals: readonly string[];
  readonly books: readonly { book_id: string; equity_gbp: number; size_multiplier: number }[];
}

const MS_PER_DAY = 86_400_000;

export function calendarDaysBetween(from: string | undefined, to: string): number {
  if (from === undefined) return 0;
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY));
}

function priceInGbp(decision: SleeveDecision, gbpUsd: number): { price: number; atr: number } {
  const divisor = decision.venue === 'alpaca' ? gbpUsd : 1;
  return { price: decision.price / divisor, atr: (decision.atr ?? 0) / divisor };
}

interface Submission {
  readonly outcome: OrderOutcome;
  readonly detail: string;
  readonly target?: number | undefined;
}

async function submitEntry(
  deps: CycleDeps,
  decision: SleeveDecision,
  clientOrderId: string,
  size: number,
  targetAtrMultiple: number,
): Promise<Submission> {
  if (decision.stop_price === undefined || decision.atr === undefined) {
    return { outcome: 'rejected', detail: 'no_stop_price' };
  }
  const targetDistance = targetAtrMultiple * decision.atr;
  const target =
    decision.action === 'enter_short'
      ? decision.price - targetDistance
      : decision.price + targetDistance;
  try {
    const ack = await deps.brokers[decision.venue].submitBracket({
      client_order_id: clientOrderId,
      instrument: decision.instrument,
      asset_class: 'stocks',
      side: decision.action === 'enter_short' ? 'sell' : 'buy',
      size,
      entry: decision.price,
      stop: decision.stop_price,
      target,
      time_in_force: 'gtc',
    });
    return { outcome: 'submitted', detail: ack.order_state, target };
  } catch (error) {
    if (error instanceof DryRunRefusedError)
      return { outcome: 'refused_dry_run', detail: error.message, target };
    return { outcome: 'rejected', detail: describeThrownSafely(error), target };
  }
}

interface Tally {
  submitted: number;
  refused: number;
  rejected: number;
  entries: number;
}

interface BookMark {
  readonly equityGbp: number;
  readonly multiplier: number;
  readonly macroDay: boolean;
}

function markBook(
  deps: CycleDeps,
  book: BookSpec,
  tradingDate: string,
  macro: MacroGateVerdict,
): BookMark {
  const previous = deps.books.lastDay(book.id);
  const day = deps.books.markDay(
    book.id,
    tradingDate,
    previous?.equityGbp ?? deps.books.startCapital,
    0,
    calendarDaysBetween(previous?.tradingDate, tradingDate),
  );
  return {
    equityGbp: day.equityGbp,
    multiplier: day.state.entriesBlockedAtNextFill ? 0 : day.state.sizeMultiplier,
    macroDay: book.variant === 'no-macro-gate' ? false : macro.macroDay,
  };
}

function sizeFor(deps: CycleDeps, mark: BookMark, decision: SleeveDecision): number {
  if (decision.action !== 'enter_long' && decision.action !== 'enter_short') return 0;
  if (deps.riskFraction === undefined) return 0;
  const { price, atr } = priceInGbp(decision, deps.gbpUsdAtYearStart);
  return positionSizeShares({
    equityGbp: mark.equityGbp,
    riskFraction: deps.riskFraction,
    priceGbp: price,
    atrGbp: atr,
    sizeMultiplier: mark.multiplier,
    macroDay: mark.macroDay,
  });
}

async function submitAndJournal(
  deps: CycleDeps,
  book: BookSpec,
  tradingDate: string,
  decision: SleeveDecision,
  decisionId: string,
  size: number,
  targetAtrMultiple: number,
  tally: Tally,
): Promise<void> {
  tally.entries += 1;
  const clientOrderId = `v2-${book.id.replaceAll('/', '-')}-${tradingDate}-${decision.instrument}`;
  const submission = await submitEntry(deps, decision, clientOrderId, size, targetAtrMultiple);
  deps.journal.recordOrder({
    client_order_id: clientOrderId,
    decision_id: decisionId,
    book_id: book.id,
    venue: decision.venue,
    dry_run: deps.dryRun,
    outcome: submission.outcome,
    payload: {
      size,
      detail: submission.detail,
      price: decision.price,
      stop: decision.stop_price,
      target: submission.target,
    },
  });
  if (submission.outcome === 'submitted') tally.submitted += 1;
  else if (submission.outcome === 'refused_dry_run') tally.refused += 1;
  else tally.rejected += 1;
}

async function applyToBook(
  deps: CycleDeps,
  book: BookSpec,
  tradingDate: string,
  macro: MacroGateVerdict,
  decisions: readonly SleeveDecision[],
  tally: Tally,
): Promise<{ book_id: string; equity_gbp: number; size_multiplier: number }> {
  const mark = markBook(deps, book, tradingDate, macro);
  for (const decision of decisions) {
    const size = sizeFor(deps, mark, decision);
    const decisionId = deps.journal.recordDecision(book.id, tradingDate, decision, size);
    if (size > 0 && book.variant === 'primary' && deps.targetAtrMultiple !== undefined) {
      await submitAndJournal(
        deps,
        book,
        tradingDate,
        decision,
        decisionId,
        size,
        deps.targetAtrMultiple,
        tally,
      );
    }
  }
  return { book_id: book.id, equity_gbp: mark.equityGbp, size_multiplier: mark.multiplier };
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

export async function runCycle(deps: CycleDeps, tradingDate: string): Promise<CycleReport> {
  deps.books.assertUnmarked(tradingDate);
  const macro = macroGate(tradingDate);
  const refusals = cycleRefusals(deps, tradingDate, macro);
  const tally: Tally = { submitted: 0, refused: 0, rejected: 0, entries: 0 };
  const books: { book_id: string; equity_gbp: number; size_multiplier: number }[] = [];
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
      books.push(await applyToBook(deps, book, tradingDate, macro, output.decisions, tally));
    }
  }
  const report: CycleReport = {
    trading_date: tradingDate,
    dry_run: deps.dryRun,
    macro,
    sleeves: deps.registry.ids(),
    decisions: decisionCount,
    entries: tally.entries,
    submitted_orders: tally.submitted,
    dry_run_refusals: tally.refused,
    rejected_orders: tally.rejected,
    refusals,
    books,
  };
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
