import type {
  BookSpec,
  SignalWire,
  SleeveDecision,
  V2Bar,
} from '../../../../contracts/index.js';
import type { LlmPanel } from '../signal/index.js';
import {
  civilDateKey,
  ET_ZONE,
  toCivilDate,
} from '../../../providers/market-data-service/index.js';
import { describeThrownSafely, digest } from '../../../shared/index.js';
import { type CycleDeps, type EntryPassReport, runEntryPass } from '../cycle.js';
import { isFresh } from '../data/index.js';
import type { ReconcileVerdict } from '../journal/journal.js';
import { SIGNALS_SLEEVE_ID } from '../signal/index.js';
import { planSignalEntry, type SignalEntryPlan } from './entry.js';
import type { SignalStore } from './store.js';
import { SIGNAL_VETO_BARS, type SignalVeto, signalVeto } from './veto.js';

const TICKET = '#1941';

export interface SignalProcessorDeps {
  readonly cycle: CycleDeps;
  readonly latestReconcile: (tradingDate: string) => ReconcileVerdict;
  readonly signals: Pick<SignalStore, 'due' | 'appendEvent'>;
  readonly panel: Pick<LlmPanel, 'judge' | 'spendCap'>;
  readonly constituents: (tradingDate: string) => readonly string[];
  readonly calendar: { isOpen(instant: Date): boolean };
}

export type SignalOutcomeStatus = 'processed' | 'refused' | 'failed';

export interface SignalOutcome {
  readonly signal_id: string;
  readonly symbol: string;
  readonly status: SignalOutcomeStatus;
  readonly detail: string;
}

interface Refusal {
  readonly code: string;
  readonly detail: string;
}

interface Admitted {
  readonly plan: SignalEntryPlan;
  readonly lastBar: V2Bar;
}

export function sessionDate(instant: Date): string {
  return civilDateKey(toCivilDate(instant, ET_ZONE));
}

// Date-free, so a pass that crashed after submitting is recognised on any later retry
export function signalEntryOrderId(signalId: string) {
  return (book: BookSpec, instrument: string): string =>
    `v2-${book.id.replaceAll('/', '-')}-${instrument}-${signalId}`;
}

function signalsBooks(deps: SignalProcessorDeps): readonly BookSpec[] {
  return deps.cycle.books.forSleeve(SIGNALS_SLEEVE_ID);
}

function simulated(deps: SignalProcessorDeps, book: BookSpec): boolean {
  return deps.cycle.executor.simulates({ bookVariant: book.variant, venue: 'alpaca' });
}

function allBooks(deps: SignalProcessorDeps): BookSpec[] {
  return deps.cycle.registry.ids().flatMap((id) => [...deps.cycle.books.forSleeve(id)]);
}

function holdsOrRests(deps: SignalProcessorDeps, book: BookSpec, symbol: string): boolean {
  if (deps.cycle.books.position(book.id, symbol) !== undefined) return true;
  return deps.cycle.journal.restingEntries(book.id).some((order) => order.instrument === symbol);
}

// One Alpaca account serves every broker-routed book, so a second book's opposite or stacked
// order on the same symbol would net against the first at the broker
function conflictingBooks(deps: SignalProcessorDeps, symbol: string): string[] {
  return allBooks(deps)
    .filter((book) => book.sleeve === SIGNALS_SLEEVE_ID || !simulated(deps, book))
    .filter((book) => holdsOrRests(deps, book, symbol))
    .map((book) => book.id);
}

function alreadySubmitted(deps: SignalProcessorDeps, signal: SignalWire): boolean {
  const orderId = signalEntryOrderId(signal.signal_id);
  return signalsBooks(deps).some(
    (book) => deps.cycle.journal.orderFor(orderId(book, signal.symbol)) !== undefined,
  );
}

function gateRefusal(
  deps: SignalProcessorDeps,
  signal: SignalWire,
  tradingDate: string,
): Refusal | undefined {
  if (sessionDate(new Date(signal.process_after)) !== tradingDate) {
    return { code: 'session_missed', detail: `due in the ${signal.process_after} session` };
  }
  const control = deps.cycle.controls.current();
  if (control.state !== 'running') {
    return { code: `manual_control_${control.state}`, detail: control.reason };
  }
  const capital = deps.cycle.risk.capitalRefusal(tradingDate);
  if (capital !== undefined) return { code: 'no_capital_config', detail: capital };
  if (!deps.constituents(tradingDate).includes(signal.symbol)) {
    return { code: 'not_in_universe', detail: `${signal.symbol} is not a current S&P 500 constituent` };
  }
  return undefined;
}

function admit(
  deps: SignalProcessorDeps,
  signal: SignalWire,
  tradingDate: string,
): Admitted | Refusal {
  const gate = gateRefusal(deps, signal, tradingDate);
  if (gate !== undefined) return gate;
  const lastBar = deps.cycle.market.lastBarBefore(signal.symbol, tradingDate);
  const lastDate = lastBar?.date ?? 'none';
  if (lastBar === undefined || !isFresh(lastBar, tradingDate)) {
    return { code: 'stale_last_close', detail: `last bar ${lastDate} before ${tradingDate}` };
  }
  const verdict = planSignalEntry(signal, lastBar.rawClose);
  if (!verdict.ok) return { code: verdict.refusal, detail: verdict.detail };
  const conflicts = conflictingBooks(deps, signal.symbol);
  if (conflicts.length > 0) {
    return { code: 'symbol_held', detail: `held or resting in ${conflicts.join(', ')}` };
  }
  return { plan: verdict.plan, lastBar };
}

function entryRange(entry: SignalWire['entry']): { low: number; high: number } {
  return typeof entry === 'number' ? { low: entry, high: entry } : { low: entry[0], high: entry[1] };
}

function decisionFor(
  signal: SignalWire,
  admitted: Admitted,
  bars: readonly V2Bar[],
  veto: SignalVeto,
): SleeveDecision {
  const { plan, lastBar } = admitted;
  const { low, high } = entryRange(signal.entry);
  return {
    sleeve_id: SIGNALS_SLEEVE_ID,
    instrument: signal.symbol,
    venue: 'alpaca',
    direction: 'bullish',
    confidence: 1,
    action: 'enter_long',
    reason: `signal ${signal.signal_id}: limit ${plan.limit} stop ${plan.stop} target ${plan.target}; veto ${veto.kind}: ${veto.reason}`,
    price: plan.limit,
    atr: plan.riskPerShare,
    stop_price: plan.stop,
    target_price: plan.target,
    inputs_hash: digest({ signal: signal.signal_id, bars }),
    debate_id: undefined,
    veto: veto.kind === 'pass' ? undefined : `${veto.kind}: ${veto.reason}`,
    payload: {
      signal_id: signal.signal_id,
      entry_low: low,
      entry_high: high,
      targets: signal.targets,
      size_hint: signal.size,
      trail_after: signal.trail_after,
      source: signal.source,
      last_close: lastBar.rawClose,
      last_close_date: lastBar.date,
      r: plan.riskPerShare,
      veto_kind: veto.kind,
      veto_reason: veto.reason,
    },
  };
}

function reconcileBlocked(deps: SignalProcessorDeps, tradingDate: string): Set<string> {
  const verdict = deps.latestReconcile(tradingDate);
  const blocked = new Set<string>();
  for (const book of signalsBooks(deps)) {
    const unreconciled = !simulated(deps, book) && !verdict.reconciled.has(book.id);
    if (unreconciled || verdict.blocked.has(book.id)) blocked.add(book.id);
  }
  return blocked;
}

function journalBlocked(
  deps: SignalProcessorDeps,
  signal: SignalWire,
  tradingDate: string,
  blocked: ReadonlySet<string>,
): void {
  for (const bookId of blocked) {
    deps.cycle.journal.recordRefusal({
      trading_date: tradingDate,
      scope: 'signal',
      parameter: 'reconcile_not_clean',
      ticket: TICKET,
      message: `${bookId} ${signal.symbol}: signal ${signal.signal_id} not entered, no clean ${tradingDate} reconcile`,
      book_id: bookId,
      instrument: signal.symbol,
    });
  }
}

function passDetail(veto: SignalVeto, report: EntryPassReport, blocked: ReadonlySet<string>): string {
  const blockedNote = blocked.size === 0 ? '' : `; reconcile blocked ${[...blocked].join(', ')}`;
  return (
    `veto ${veto.kind}: ${veto.reason}; entries ${report.entries}, submitted ${report.submitted_orders}, ` +
    `simulated ${report.simulated_orders}, dry-run ${report.dry_run_refusals}, rejected ${report.rejected_orders}${blockedNote}`
  );
}

async function enter(
  deps: SignalProcessorDeps,
  signal: SignalWire,
  tradingDate: string,
  admitted: Admitted,
): Promise<string> {
  const bars = deps.cycle.market.barsBefore(signal.symbol, tradingDate, SIGNAL_VETO_BARS);
  const { low, high } = entryRange(signal.entry);
  const veto = await signalVeto(
    deps.panel.judge,
    deps.panel.spendCap,
    {
      symbol: signal.symbol,
      entryLow: low,
      entryHigh: high,
      limit: admitted.plan.limit,
      stop: admitted.plan.stop,
      target: admitted.plan.target,
      targets: signal.targets,
      lastClose: admitted.lastBar.rawClose,
      bars,
    },
    `v2-signal-${signal.signal_id}`,
  );
  const decision = decisionFor(signal, admitted, bars, veto);
  const blocked = reconcileBlocked(deps, tradingDate);
  journalBlocked(deps, signal, tradingDate, blocked);
  const report = await runEntryPass(deps.cycle, {
    tradingDate,
    sleeveId: SIGNALS_SLEEVE_ID,
    decisionsFor: () => [decision],
    entryOrderId: signalEntryOrderId(signal.signal_id),
    blockedBookIds: blocked,
  });
  return passDetail(veto, report, blocked);
}

function refuse(
  deps: SignalProcessorDeps,
  signal: SignalWire,
  tradingDate: string,
  refusal: Refusal,
): SignalOutcome {
  deps.cycle.journal.recordRefusal({
    trading_date: tradingDate,
    scope: 'signal',
    parameter: refusal.code,
    ticket: TICKET,
    message: `signal ${signal.signal_id} ${signal.symbol}: ${refusal.detail}`,
    instrument: signal.symbol,
  });
  return settle(deps, signal, 'refused', `${refusal.code}: ${refusal.detail}`);
}

function settle(
  deps: SignalProcessorDeps,
  signal: SignalWire,
  status: SignalOutcomeStatus,
  detail: string,
): SignalOutcome {
  deps.signals.appendEvent(signal.signal_id, status, detail);
  deps.cycle.logger?.log({
    trace_id: `v2-signal-${signal.signal_id}`,
    stage: 'v2',
    level: status === 'failed' ? 'error' : 'info',
    event: `v2_signal_${status}`,
    message: `${signal.symbol} ${signal.signal_id}: ${detail}`,
  });
  return { signal_id: signal.signal_id, symbol: signal.symbol, status, detail };
}

async function processOne(
  deps: SignalProcessorDeps,
  signal: SignalWire,
  tradingDate: string,
): Promise<SignalOutcome> {
  if (alreadySubmitted(deps, signal)) {
    return settle(deps, signal, 'processed', 'already_submitted: an entry order for this signal exists');
  }
  const admitted = admit(deps, signal, tradingDate);
  if ('code' in admitted) return refuse(deps, signal, tradingDate, admitted);
  return settle(deps, signal, 'processed', await enter(deps, signal, tradingDate, admitted));
}

export async function processDueSignals(
  deps: SignalProcessorDeps,
  now: Date,
): Promise<readonly SignalOutcome[]> {
  if (!deps.calendar.isOpen(now)) return [];
  const tradingDate = sessionDate(now);
  const outcomes: SignalOutcome[] = [];
  for (const signal of deps.signals.due(now)) {
    try {
      outcomes.push(await processOne(deps, signal, tradingDate));
    } catch (error) {
      outcomes.push(settle(deps, signal, 'failed', describeThrownSafely(error)));
    }
  }
  return outcomes;
}
