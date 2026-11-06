import type { Venue } from '../../../contracts/index.js';
import type { BarSeries, DailyBar } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import type { BarsSource } from './data/index.js';
import { CLOSE_LEGS_SQL, entryColumnOfClose, entryOffsetOfPayload } from './entry-offset.js';
import { quoted, simulateLimitEntry } from './simulated-entry.js';
import { cumulativeSplitRatios } from './split.js';

const SCHEMA_VERSION = 1;

// The index bar for an exit session lands with the next bar refresh, so a few of the trade's own
// sessions past the exit with none means the index series has a gap there or has stopped
export const BENCHMARK_PENDING_MAX_SESSIONS = 3;

const QTY_RELATIVE_EPSILON = 1e-9;

// David ruled 2026-10-22 on #2146: each trade is scored against its venue's home index
const BENCHMARK_OF_VENUE: Readonly<Record<Venue, string>> = {
  alpaca: 'SPY',
  saxo_cfd_usd: 'SPY',
  saxo: 'ISF',
  saxo_cfd_gbp: 'ISF',
};

const DETAIL_REASONS: Readonly<Record<string, string>> = {
  stop_on_entry_bar: 'stop',
  series_ended_at_last_close: 'series_ended',
};

export interface OutcomeFill {
  readonly qty: number;
  readonly price_gbp: number;
  readonly price_native: number | null;
  readonly fee_gbp: number;
  readonly fill_date: string | null;
  readonly filled_at: string | null;
  readonly trading_date: string;
}

export interface OutcomeEntry {
  readonly entry_order_id: string;
  readonly decision_id: string;
  readonly decision_date: string;
  readonly order_date: string;
  readonly sleeve_id: string;
  readonly venue: Venue;
  readonly side: 'buy' | 'sell';
  readonly limit: number | null;
  readonly trigger: number | null;
  readonly quoted: 0 | 1;
  readonly quote_fill: number | null;
  readonly stop: number | null;
  readonly target: number | null;
  readonly pin_digest: string | null;
  readonly entry_offset_bps: number | null;
}

export interface OutcomeExit {
  readonly leg: string;
  readonly order_date: string;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly trigger: number | null;
}

type NonEmpty<T> = readonly [T, ...T[]];

export interface ClosedTrade {
  readonly bookId: string;
  readonly instrument: string;
  readonly entryOrderId: string;
  readonly exitOrderId: string;
  readonly settledAt: string;
  readonly entry: OutcomeEntry;
  readonly exit: OutcomeExit;
  readonly entryFills: NonEmpty<OutcomeFill>;
  readonly exitFills: NonEmpty<OutcomeFill>;
  readonly cashInLieu: readonly OutcomeFill[];
  readonly exitShare: number;
  readonly carryGbp: number;
  readonly rescaled: boolean;
  readonly splitBlocked: boolean;
}

export interface FillBars {
  readonly entry: string;
  readonly exit: string;
}

export interface DecisionOutcome {
  readonly decision_id: string;
  readonly book_id: string;
  readonly sleeve_id: string;
  readonly instrument: string;
  readonly venue: Venue;
  readonly direction: 'long' | 'short';
  readonly decision_date: string;
  readonly entry_client_order_id: string;
  readonly exit_client_order_id: string;
  readonly exit_leg: string;
  readonly exit_reason: string;
  readonly entry_date: string;
  readonly exit_date: string;
  readonly entry_filled_at: string | null;
  readonly exit_filled_at: string | null;
  readonly holding_days: number;
  readonly entry_qty: number;
  readonly exit_qty: number;
  readonly entry_price_gbp: number;
  readonly exit_price_gbp: number;
  readonly entry_price_native: number | null;
  readonly exit_price_native: number | null;
  readonly fees_gbp: number;
  readonly carry_gbp: number;
  readonly realised_pnl_gbp: number;
  readonly trade_return: number;
  readonly r_multiple: number | null;
  readonly benchmark_symbol: string;
  readonly benchmark_return: number;
  readonly excess_return: number;
  readonly pin_digest: string | null;
  readonly entry_offset_bps: number | null;
  readonly settled_at: string;
  readonly schema_version: number;
}

export type PendingReason =
  | 'position_open'
  | 'fill_bar'
  | 'benchmark_bars'
  | 'benchmark_missing'
  | 'benchmark_stale';

export type AnomalyReason = 'close_side' | 'closed_qty';

interface CloseKey {
  readonly bookId: string;
  readonly instrument: string;
  readonly exitOrderId: string;
}

export interface PendingOutcome extends CloseKey {
  readonly reason: PendingReason;
}

export interface AnomalousOutcome extends CloseKey {
  readonly reason: AnomalyReason;
}

export interface OutcomeRebuild {
  readonly written: number;
  readonly settled: number;
  readonly pending: readonly PendingOutcome[];
  readonly unmatched: readonly string[];
  readonly anomalous: readonly AnomalousOutcome[];
}

interface Totals {
  readonly qty: number;
  readonly valueGbp: number;
  readonly valueNative: number | null;
  readonly feeGbp: number;
}

interface BenchmarkWindow {
  readonly first: DailyBar;
  readonly last: DailyBar;
  readonly sessions: number;
}

function totalsOf(fills: readonly OutcomeFill[]): Totals {
  let qty = 0;
  let valueGbp = 0;
  let valueNative: number | null = 0;
  let feeGbp = 0;
  for (const fill of fills) {
    qty += fill.qty;
    valueGbp += fill.qty * fill.price_gbp;
    valueNative =
      valueNative === null || fill.price_native === null
        ? null
        : valueNative + fill.qty * fill.price_native;
    feeGbp += fill.fee_gbp;
  }
  return { qty, valueGbp, valueNative, feeGbp };
}

function averageNative(totals: Totals): number | null {
  return totals.valueNative === null ? null : totals.valueNative / totals.qty;
}

// The trigger is the stop or the target, or a gap open beyond one, and the journalled level can
// differ from the trigger in its last float digit; the side of the midpoint decides. After a
// split the trigger is in the new units and the entry's levels are not
function bracketSideOf(trade: ClosedTrade, sign: number): string {
  const { trigger } = trade.exit;
  const { stop, target } = trade.entry;
  if (trade.rescaled || trigger === null || stop === null || target === null) return 'unclassified';
  return sign * (trigger - (stop + target) / 2) >= 0 ? 'target' : 'stop';
}

export function exitReasonOf(trade: ClosedTrade, sign: number): string {
  const { leg, reason, detail } = trade.exit;
  if (leg === 'stop' || leg === 'target') return leg;
  if (reason !== null) return reason;
  if (detail === 'bracket_leg_on_daily_bar') return bracketSideOf(trade, sign);
  return DETAIL_REASONS[detail ?? ''] ?? 'unclassified';
}

function barsBetween(bars: readonly DailyBar[], from: string, before: string): readonly DailyBar[] {
  return bars.filter((bar) => bar.date >= from && bar.date < before);
}

function splitInWindow(
  entry: OutcomeEntry,
  bars: readonly DailyBar[],
  window: readonly DailyBar[],
) {
  const decisionBar = bars.findLast((bar) => bar.date < entry.order_date);
  return cumulativeSplitRatios(decisionBar, window).some((ratio) => ratio !== 1);
}

// Mirrors cycle.ts fillSimulatedEntry; keep in step. Ruling 3 on #2146 leaves an entry undated
// when a split falls in its fill window
function entryBarOf(trade: ClosedTrade, bars: readonly DailyBar[]): string | undefined {
  const { entry } = trade;
  const [fill] = trade.entryFills;
  if (fill.fill_date !== null) return fill.fill_date;
  const window = barsBetween(bars, entry.order_date, fill.trading_date);
  if (window.length === 1) return window[0]?.date;
  if (entry.limit === null || splitInWindow(entry, bars, window)) return undefined;
  const outcome = simulateLimitEntry(
    {
      side: entry.side,
      limit: entry.limit,
      stop: undefined,
      trigger: entry.trigger ?? undefined,
      quoteFill: entry.quoted === 1 ? entry.quote_fill : undefined,
    },
    window,
  );
  return outcome.kind === 'filled' ? outcome.bar.date : undefined;
}

// Mirrors cycle.ts afterEntryFill, exitBars and the bracket legs on lastBarBefore; keep in step
function exitBarOf(
  trade: ClosedTrade,
  entryBar: string,
  bars: readonly DailyBar[],
): string | undefined {
  const [fill] = trade.exitFills;
  if (fill.fill_date !== null) return fill.fill_date;
  if (trade.exit.detail === 'stop_on_entry_bar') return entryBar;
  const window = barsBetween(bars, trade.exit.order_date, fill.trading_date);
  const priced = trade.splitBlocked ? window.at(-1) : window[0];
  return (priced ?? bars.findLast((bar) => bar.date < fill.trading_date))?.date;
}

export function fillBarsOf(
  trade: ClosedTrade,
  series: BarSeries | undefined,
): FillBars | undefined {
  const bars = series?.bars ?? [];
  const entry = entryBarOf(trade, bars);
  const exit = entry === undefined ? undefined : exitBarOf(trade, entry, bars);
  return entry === undefined || exit === undefined ? undefined : { entry, exit };
}

// Final once the index has a bar on or after the exit bar, so newer bars cannot move the window
export function benchmarkWindowOf(
  series: BarSeries | undefined,
  dates: FillBars,
): BenchmarkWindow | undefined {
  const bars = series?.bars ?? [];
  if ((bars.at(-1)?.date ?? '') < dates.exit) return undefined;
  const firstIndex = bars.findIndex((bar) => bar.date >= dates.entry);
  const lastIndex = bars.findLastIndex((bar) => bar.date <= dates.exit);
  const first = bars[firstIndex];
  const last = bars[lastIndex];
  if (first === undefined || last === undefined || lastIndex < firstIndex) return undefined;
  return { first, last, sessions: lastIndex - firstIndex };
}

// Trade prices carry no dividends, so the index is compared price-only too
function priceReturnOf(window: BenchmarkWindow): number {
  return window.last.rawClose / quoted(window.first).open - 1;
}

function rMultipleOf(trade: ClosedTrade, sign: number, entry: Totals, exit: Totals): number | null {
  const entryNative = averageNative(entry);
  const exitNative = averageNative(exit);
  const { stop } = trade.entry;
  if (trade.rescaled || stop === null || entryNative === null || exitNative === null) return null;
  const risk = Math.abs(entryNative - stop);
  return risk === 0 ? null : (sign * (exitNative - entryNative)) / risk;
}

export function outcomeOf(
  trade: ClosedTrade,
  dates: FillBars,
  benchmark: BarSeries | undefined,
): DecisionOutcome | undefined {
  const window = benchmarkWindowOf(benchmark, dates);
  if (window === undefined) return undefined;
  const sign = trade.entry.side === 'buy' ? 1 : -1;
  const entry = totalsOf(trade.entryFills);
  const exit = totalsOf(trade.exitFills);
  const cashInLieu = totalsOf(trade.cashInLieu);
  const entryValueGbp = entry.valueGbp * trade.exitShare;
  const fees = entry.feeGbp * trade.exitShare + exit.feeGbp + cashInLieu.feeGbp;
  const carry = trade.carryGbp * trade.exitShare;
  const realised = sign * (exit.valueGbp + cashInLieu.valueGbp - entryValueGbp) - fees - carry;
  const tradeReturn = realised / entryValueGbp;
  const benchmarkReturn = priceReturnOf(window);
  return {
    decision_id: trade.entry.decision_id,
    book_id: trade.bookId,
    sleeve_id: trade.entry.sleeve_id,
    instrument: trade.instrument,
    venue: trade.entry.venue,
    direction: sign === 1 ? 'long' : 'short',
    decision_date: trade.entry.decision_date,
    entry_client_order_id: trade.entryOrderId,
    exit_client_order_id: trade.exitOrderId,
    exit_leg: trade.exit.leg,
    exit_reason: exitReasonOf(trade, sign),
    entry_date: dates.entry,
    exit_date: dates.exit,
    entry_filled_at: trade.entryFills[0].filled_at,
    exit_filled_at: trade.exitFills[0].filled_at,
    holding_days: window.sessions,
    entry_qty: entry.qty * trade.exitShare,
    exit_qty: exit.qty,
    entry_price_gbp: entry.valueGbp / entry.qty,
    exit_price_gbp: exit.valueGbp / exit.qty,
    entry_price_native: averageNative(entry),
    exit_price_native: averageNative(exit),
    fees_gbp: fees,
    carry_gbp: carry,
    realised_pnl_gbp: realised,
    trade_return: tradeReturn,
    r_multiple: rMultipleOf(trade, sign, entry, exit),
    benchmark_symbol: BENCHMARK_OF_VENUE[trade.entry.venue],
    benchmark_return: benchmarkReturn,
    excess_return: tradeReturn - sign * benchmarkReturn,
    pin_digest: trade.entry.pin_digest,
    entry_offset_bps: trade.entry.entry_offset_bps,
    settled_at: trade.settledAt,
    schema_version: SCHEMA_VERSION,
  };
}

interface CloseRow {
  readonly book_id: string;
  readonly instrument: string;
  readonly exit_order_id: string;
  readonly settled_at: string;
  readonly at: number;
  readonly entry_order_id: string | null;
}

const CLOSES_SQL = `
  WITH closes AS (
    SELECT book_id, instrument, client_order_id, MIN(rowid) AS at, MIN(trading_date) AS trading_date
      FROM v2_fills WHERE ${CLOSE_LEGS_SQL} GROUP BY book_id, client_order_id
  )
  SELECT c.book_id, c.instrument, c.client_order_id AS exit_order_id, c.trading_date AS settled_at,
         c.at,
         ${entryColumnOfClose(
           {
             bookId: 'c.book_id',
             instrument: 'c.instrument',
             orderId: 'c.client_order_id',
             at: 'c.at',
           },
           'client_order_id',
         )} AS entry_order_id
    FROM closes c ORDER BY c.at`;

const ENTRY_SQL = `
  SELECT o.client_order_id AS entry_order_id, o.decision_id, d.trading_date AS decision_date,
         o.trading_date AS order_date, b.sleeve_id, o.venue, o.side,
         COALESCE(json_extract(o.payload, '$.limit'), json_extract(o.payload, '$.price')) AS "limit",
         json_extract(o.payload, '$.trigger') AS trigger,
         json_extract(o.payload, '$.entry_quote') IS NOT NULL AS quoted,
         json_extract(o.payload, '$.entry_quote.fill') AS quote_fill,
         json_extract(o.payload, '$.stop') AS stop, json_extract(o.payload, '$.target') AS target,
         json_extract(o.payload, '$.pin_digest') AS pin_digest,
         ${entryOffsetOfPayload('o.payload')} AS entry_offset_bps
    FROM v2_orders o
    JOIN v2_decisions d ON d.decision_id = o.decision_id
    JOIN v2_books b ON b.book_id = o.book_id
   WHERE o.client_order_id = ?`;

// day_ordinal places a fill against a v2_rescales row, which applies after fills_before of its
// day's fills (replay-book.ts rebuildBooks)
const FILL_COLUMNS = `fill_seq, leg, side, qty, price_gbp, price_native, fee_gbp, fill_date,
  filled_at, trading_date, (SELECT COUNT(*) FROM v2_fills d
    WHERE d.trading_date = f.trading_date AND d.fill_seq < f.fill_seq) AS day_ordinal`;

const ENTRY_FILLS_SQL = `SELECT ${FILL_COLUMNS} FROM v2_fills f
  WHERE client_order_id = ? AND leg = 'entry' ORDER BY fill_seq`;

const EXIT_FILLS_SQL = `SELECT ${FILL_COLUMNS} FROM v2_fills f
  WHERE book_id = ? AND client_order_id = ? AND ${CLOSE_LEGS_SQL} ORDER BY fill_seq`;

const CASH_IN_LIEU_SQL = `SELECT ${FILL_COLUMNS} FROM v2_fills f
  WHERE book_id = ? AND client_order_id = ? AND leg = 'cash_in_lieu' ORDER BY fill_seq`;

const EXIT_ORDER_SQL = `
  SELECT trading_date AS order_date, json_extract(payload, '$.reason') AS reason,
         json_extract(payload, '$.detail') AS detail, json_extract(payload, '$.price') AS trigger
    FROM v2_orders WHERE client_order_id = ? AND leg <> 'entry'`;

const HOLDS_ENTRY_SQL = `SELECT 1 FROM v2_positions
  WHERE book_id = ? AND instrument = ? AND client_order_id = ?`;

const CARRY_SQL = `SELECT COALESCE(SUM(financing_gbp + borrow_gbp), 0) AS carry FROM v2_cfd_carry
  WHERE book_id = ? AND client_order_id = ?`;

const RESCALES_SQL = `SELECT trading_date, fills_before, ratio FROM v2_rescales
  WHERE book_id = ? AND instrument = ? AND trading_date >= ? ORDER BY rescale_id`;

const SPLIT_BLOCKED_SQL = `SELECT 1 FROM v2_split_checks
  WHERE instrument = ? AND verdict = 'block' AND trading_date >= ? AND trading_date < ?`;

const WRITTEN_SQL = 'SELECT book_id, exit_client_order_id FROM v2_decision_outcomes';

const OUTCOME_COLUMNS = [
  'decision_id',
  'book_id',
  'sleeve_id',
  'instrument',
  'venue',
  'direction',
  'decision_date',
  'entry_client_order_id',
  'exit_client_order_id',
  'exit_leg',
  'exit_reason',
  'entry_date',
  'exit_date',
  'entry_filled_at',
  'exit_filled_at',
  'holding_days',
  'entry_qty',
  'exit_qty',
  'entry_price_gbp',
  'exit_price_gbp',
  'entry_price_native',
  'exit_price_native',
  'fees_gbp',
  'carry_gbp',
  'realised_pnl_gbp',
  'trade_return',
  'r_multiple',
  'benchmark_symbol',
  'benchmark_return',
  'excess_return',
  'pin_digest',
  'entry_offset_bps',
  'settled_at',
  'schema_version',
] as const;

const INSERT_SQL = `INSERT INTO v2_decision_outcomes (${OUTCOME_COLUMNS.join(', ')})
  VALUES (${OUTCOME_COLUMNS.map((column) => `@${column}`).join(', ')})`;

interface JournalFill extends OutcomeFill {
  readonly fill_seq: number;
  readonly day_ordinal: number;
  readonly leg: string;
  readonly side: 'buy' | 'sell';
}

type JournalFills = NonEmpty<JournalFill>;

interface RescaleRow {
  readonly trading_date: string;
  readonly fills_before: number;
  readonly ratio: number;
}

type CloseVerdict =
  | {
      readonly kind: 'share';
      readonly share: number;
      readonly cashInLieu: readonly JournalFill[];
    }
  | { readonly kind: 'anomalous'; readonly reason: AnomalyReason };

interface EntryLedger {
  readonly entryFills: JournalFills;
  readonly rescales: readonly RescaleRow[];
  readonly closeFills: ReadonlyMap<string, JournalFills>;
  readonly verdicts: ReadonlyMap<string, CloseVerdict>;
}

type Settlement =
  | { readonly kind: 'settled'; readonly outcome: DecisionOutcome }
  | { readonly kind: 'pending'; readonly reason: PendingReason }
  | { readonly kind: 'anomalous'; readonly reason: AnomalyReason }
  | { readonly kind: 'unmatched' };

const UNMATCHED: Settlement = { kind: 'unmatched' };

function pending(reason: PendingReason): Settlement {
  return { kind: 'pending', reason };
}

function anomalous(reason: AnomalyReason): CloseVerdict {
  return { kind: 'anomalous', reason };
}

function keyOf(bookId: string, exitOrderId: string): string {
  return `${bookId}|${exitOrderId}`;
}

function quantityOf(fills: readonly OutcomeFill[]): number {
  return fills.reduce((sum, fill) => sum + fill.qty, 0);
}

function precedes(rescale: RescaleRow, fill: JournalFill): boolean {
  if (rescale.trading_date !== fill.trading_date) return rescale.trading_date < fill.trading_date;
  return rescale.fills_before <= fill.day_ordinal;
}

function ratioAt(rescales: readonly RescaleRow[], fill: JournalFill): number {
  return rescales.reduce(
    (ratio, rescale) => (precedes(rescale, fill) ? ratio * rescale.ratio : ratio),
    1,
  );
}

function entryUnitsOf(rescales: readonly RescaleRow[], fills: readonly JournalFill[]): number {
  return fills.reduce((sum, fill) => sum + fill.qty / ratioAt(rescales, fill), 0);
}

// #2146 ruling 3 (2026-11-06): the entry's closes, in journal order, settle only once they and
// the split's cash in lieu account for exactly the entry's quantity in its own units. A close
// on the entry's side, a close past that quantity, or a set that misses it is anomalous. Each
// verdict reads only the journal up to its close, so a rebuild from scratch writes what the
// cycle-by-cycle runs wrote
class CloseWalk {
  readonly #verdicts = new Map<string, CloseVerdict>();
  #accounted = 0;
  #carried: JournalFill[] = [];
  #complete = false;

  constructor(
    private readonly entryQty: number,
    private readonly entrySide: 'buy' | 'sell',
    private readonly rescales: readonly RescaleRow[],
  ) {}

  cashInLieu(fill: JournalFill): void {
    if (!this.#complete) this.#carried.push(fill);
  }

  close(exitOrderId: string, fills: readonly JournalFill[]): void {
    this.#verdicts.set(exitOrderId, this.#verdictOf(fills));
  }

  finish(): ReadonlyMap<string, CloseVerdict> {
    if (this.#complete) return this.#verdicts;
    const short = anomalous('closed_qty');
    return new Map(
      [...this.#verdicts].map(([id, verdict]) => [id, verdict.kind === 'share' ? short : verdict]),
    );
  }

  #verdictOf(fills: readonly JournalFill[]): CloseVerdict {
    if (fills.some((fill) => fill.side === this.entrySide)) return anomalous('close_side');
    if (this.#complete) return anomalous('closed_qty');
    const cashInLieu = this.#carried;
    this.#carried = [];
    const units = entryUnitsOf(this.rescales, [...fills, ...cashInLieu]);
    this.#accounted += units;
    this.#complete =
      Math.abs(this.#accounted - this.entryQty) <= QTY_RELATIVE_EPSILON * this.entryQty;
    return { kind: 'share', share: units / this.entryQty, cashInLieu };
  }
}

function benchmarkWaitOf(
  benchmark: BarSeries | undefined,
  series: BarSeries | undefined,
  dates: FillBars,
): PendingReason {
  if (benchmark === undefined) return 'benchmark_missing';
  const since = (series?.bars ?? []).filter((bar) => bar.date > dates.exit).length;
  return since >= BENCHMARK_PENDING_MAX_SESSIONS ? 'benchmark_stale' : 'benchmark_bars';
}

class JournalReader {
  readonly #closesOfEntry = new Map<string, CloseRow[]>();
  readonly #ledgers = new Map<string, EntryLedger>();

  constructor(
    private readonly db: StoreHandle,
    private readonly bars: BarsSource,
    closes: readonly CloseRow[],
  ) {
    for (const close of closes) {
      const key = keyOf(close.book_id, close.entry_order_id ?? '');
      this.#closesOfEntry.set(key, [...(this.#closesOfEntry.get(key) ?? []), close]);
    }
  }

  settle(close: CloseRow): Settlement {
    const entry = this.entryOf(close.entry_order_id);
    if (entry === undefined) return UNMATCHED;
    if (this.holdsEntry(close, entry)) return pending('position_open');
    const ledger = this.ledgerOf(close, entry);
    const verdict = ledger.verdicts.get(close.exit_order_id) as CloseVerdict;
    if (verdict.kind === 'anomalous') return verdict;
    return this.settleTrade(this.trade(close, entry, ledger, verdict));
  }

  private settleTrade(trade: ClosedTrade): Settlement {
    const series = this.bars.load(trade.instrument);
    const dates = fillBarsOf(trade, series);
    if (dates === undefined) return pending('fill_bar');
    const benchmark = this.bars.load(BENCHMARK_OF_VENUE[trade.entry.venue]);
    const outcome = outcomeOf(trade, dates, benchmark);
    if (outcome === undefined) return pending(benchmarkWaitOf(benchmark, series, dates));
    return { kind: 'settled', outcome };
  }

  private fills(sql: string, ...params: string[]): JournalFills {
    return this.db.prepare(sql).all(...params) as unknown as JournalFills;
  }

  private entryOf(entryOrderId: string | null): OutcomeEntry | undefined {
    return entryOrderId === null
      ? undefined
      : (this.db.prepare(ENTRY_SQL).get(entryOrderId) as OutcomeEntry | undefined);
  }

  private holdsEntry(close: CloseRow, entry: OutcomeEntry): boolean {
    const held = this.db
      .prepare(HOLDS_ENTRY_SQL)
      .get(close.book_id, close.instrument, entry.entry_order_id);
    return held !== undefined;
  }

  private ledgerOf(close: CloseRow, entry: OutcomeEntry): EntryLedger {
    const key = keyOf(close.book_id, entry.entry_order_id);
    const cached = this.#ledgers.get(key);
    if (cached !== undefined) return cached;
    const ledger = this.readLedger(close, entry, this.#closesOfEntry.get(key) as CloseRow[]);
    this.#ledgers.set(key, ledger);
    return ledger;
  }

  private readLedger(
    close: CloseRow,
    entry: OutcomeEntry,
    closes: readonly CloseRow[],
  ): EntryLedger {
    const entryFills = this.fills(ENTRY_FILLS_SQL, entry.entry_order_id);
    const [first] = entryFills;
    const rescales = (
      this.db
        .prepare(RESCALES_SQL)
        .all(close.book_id, close.instrument, first.trading_date) as unknown as RescaleRow[]
    ).filter((rescale) => !precedes(rescale, first));
    const closeFills = new Map(
      closes.map((row) => [
        row.exit_order_id,
        this.fills(EXIT_FILLS_SQL, row.book_id, row.exit_order_id),
      ]),
    );
    const walk = new CloseWalk(quantityOf(entryFills), entry.side, rescales);
    const events = [
      ...closes.map((row) => ({
        seq: row.at,
        apply: () =>
          walk.close(row.exit_order_id, closeFills.get(row.exit_order_id) as JournalFills),
      })),
      ...this.fills(CASH_IN_LIEU_SQL, close.book_id, entry.entry_order_id).map((fill) => ({
        seq: fill.fill_seq,
        apply: () => walk.cashInLieu(fill),
      })),
    ].sort((a, b) => a.seq - b.seq);
    for (const event of events) event.apply();
    return { entryFills, rescales, closeFills, verdicts: walk.finish() };
  }

  private exitOf(close: CloseRow, exitFills: JournalFills): OutcomeExit {
    const order = this.db.prepare(EXIT_ORDER_SQL).get(close.exit_order_id) as
      | Omit<OutcomeExit, 'leg'>
      | undefined;
    return {
      order_date: close.settled_at,
      reason: null,
      detail: null,
      trigger: null,
      ...order,
      leg: exitFills[0].leg,
    };
  }

  private found(sql: string, ...params: string[]): boolean {
    return this.db.prepare(sql).get(...params) !== undefined;
  }

  private trade(
    close: CloseRow,
    entry: OutcomeEntry,
    ledger: EntryLedger,
    verdict: Extract<CloseVerdict, { kind: 'share' }>,
  ): ClosedTrade {
    const entryOrderId = entry.entry_order_id;
    const exitFills = ledger.closeFills.get(close.exit_order_id) as JournalFills;
    const exit = this.exitOf(close, exitFills);
    const { carry } = this.db.prepare(CARRY_SQL).get(close.book_id, entryOrderId) as {
      carry: number;
    };
    const lastExit = exitFills.at(-1) as JournalFill;
    return {
      bookId: close.book_id,
      instrument: close.instrument,
      entryOrderId,
      exitOrderId: close.exit_order_id,
      settledAt: close.settled_at,
      entry,
      exit,
      entryFills: ledger.entryFills,
      exitFills,
      cashInLieu: verdict.cashInLieu,
      exitShare: verdict.share,
      carryGbp: carry,
      rescaled: ledger.rescales.some(
        (rescale) => rescale.ratio !== 1 && precedes(rescale, lastExit),
      ),
      splitBlocked: this.found(
        SPLIT_BLOCKED_SQL,
        close.instrument,
        exit.order_date,
        exitFills[0].trading_date,
      ),
    };
  }
}

export function formatOutcomeRebuild(rebuild: OutcomeRebuild): string {
  const line = (row: CloseKey) => `${row.bookId} ${row.instrument} ${row.exitOrderId}`;
  return [
    `settled ${rebuild.settled} closed trades (${rebuild.written} new)`,
    ...rebuild.pending.map((row) => `pending ${line(row)}: ${row.reason}`),
    ...rebuild.anomalous.map((row) => `anomalous ${line(row)}: ${row.reason}`),
    ...rebuild.unmatched.map((key) => `unmatched ${key}: no entry decision in the journal`),
  ].join('\n');
}

const SELF_SETTLING: ReadonlySet<PendingReason> = new Set(['position_open', 'benchmark_bars']);

export function needsAttention(rebuild: OutcomeRebuild): boolean {
  return (
    rebuild.unmatched.length > 0 ||
    rebuild.anomalous.length > 0 ||
    rebuild.pending.some((row) => !SELF_SETTLING.has(row.reason))
  );
}

function writtenKeys(db: StoreHandle): Set<string> {
  const rows = db.prepare(WRITTEN_SQL).all() as { book_id: string; exit_client_order_id: string }[];
  return new Set(rows.map((row) => keyOf(row.book_id, row.exit_client_order_id)));
}

interface Sorted {
  readonly fresh: DecisionOutcome[];
  readonly pending: PendingOutcome[];
  readonly anomalous: AnomalousOutcome[];
  readonly unmatched: string[];
}

function sortSettlement(sorted: Sorted, close: CloseRow, settlement: Settlement): void {
  const key = {
    bookId: close.book_id,
    instrument: close.instrument,
    exitOrderId: close.exit_order_id,
  };
  if (settlement.kind === 'settled') sorted.fresh.push(settlement.outcome);
  else if (settlement.kind === 'pending')
    sorted.pending.push({ ...key, reason: settlement.reason });
  else if (settlement.kind === 'anomalous')
    sorted.anomalous.push({ ...key, reason: settlement.reason });
  else sorted.unmatched.push(keyOf(close.book_id, close.exit_order_id));
}

export function rebuildDecisionOutcomes(db: StoreHandle, bars: BarsSource): OutcomeRebuild {
  const closes = db.prepare(CLOSES_SQL).all() as unknown as CloseRow[];
  const reader = new JournalReader(db, bars, closes);
  const written = writtenKeys(db);
  const sorted: Sorted = { fresh: [], pending: [], anomalous: [], unmatched: [] };
  for (const close of closes.filter((row) => !written.has(keyOf(row.book_id, row.exit_order_id)))) {
    sortSettlement(sorted, close, reader.settle(close));
  }
  const insert = db.prepare(INSERT_SQL);
  db.transaction(() => {
    for (const outcome of sorted.fresh) insert.run(outcome);
  })();
  const { fresh, ...rest } = sorted;
  return { written: fresh.length, settled: written.size + fresh.length, ...rest };
}
