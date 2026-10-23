import type { Venue } from '../../../contracts/index.js';
import type { BarSeries, DailyBar } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import type { BarsSource } from './data/index.js';
import { CLOSE_LEGS_SQL, entryColumnOfClose, entryOffsetOfPayload } from './entry-offset.js';
import { quoted, simulateLimitEntry } from './simulated-entry.js';

const SCHEMA_VERSION = 1;

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

export type PendingReason = 'position_open' | 'fill_bar' | 'benchmark_bars';

export interface PendingOutcome {
  readonly bookId: string;
  readonly instrument: string;
  readonly exitOrderId: string;
  readonly reason: PendingReason;
}

export interface OutcomeRebuild {
  readonly written: number;
  readonly settled: number;
  readonly pending: readonly PendingOutcome[];
  readonly unmatched: readonly string[];
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
// differ from the trigger in its last float digit; the side of the midpoint decides
function bracketSideOf(trade: ClosedTrade, sign: number): string {
  const { trigger } = trade.exit;
  const { stop, target } = trade.entry;
  if (trigger === null || stop === null || target === null) return 'unclassified';
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

// A simulated entry journals no fill date. The cycle walks the bars from the order to its own
// date and fills on the first that crosses (cycle.ts fillSimulatedEntry); with one bar there is
// nothing to replay, and across a split the cycle's bars were rescaled in ways the store does not keep
function entryBarOf(trade: ClosedTrade, bars: readonly DailyBar[]): string | undefined {
  const { entry } = trade;
  const [fill] = trade.entryFills;
  if (fill.fill_date !== null) return fill.fill_date;
  const window = barsBetween(bars, entry.order_date, fill.trading_date);
  if (window.length === 1) return window[0]?.date;
  if (trade.rescaled || entry.limit === null) return undefined;
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

// Mirrors the cycle's simulated exits: a stop on the fill bar exits on the entry bar; a flatten
// fills at the open of the first bar after its order, or the latest bar when a split block froze
// it (cycle.ts exitBars); a bracket leg or an ended series, journalled on the cycle that fills it,
// prices on the last bar before that cycle
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
  const entryValueGbp = entry.valueGbp * trade.exitShare;
  const fees = entry.feeGbp * trade.exitShare + exit.feeGbp;
  const carry = trade.carryGbp * trade.exitShare;
  const realised = sign * (exit.valueGbp - entryValueGbp) - fees - carry;
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
  readonly entry_order_id: string | null;
}

const CLOSES_SQL = `
  WITH closes AS (
    SELECT book_id, instrument, client_order_id, MIN(rowid) AS at, MIN(trading_date) AS trading_date
      FROM v2_fills WHERE ${CLOSE_LEGS_SQL} GROUP BY book_id, client_order_id
  )
  SELECT c.book_id, c.instrument, c.client_order_id AS exit_order_id, c.trading_date AS settled_at,
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

const FILL_COLUMNS = 'qty, price_gbp, price_native, fee_gbp, fill_date, filled_at, trading_date';

const ENTRY_FILLS_SQL = `SELECT ${FILL_COLUMNS} FROM v2_fills
  WHERE client_order_id = ? AND leg = 'entry' ORDER BY rowid`;

const EXIT_FILLS_SQL = `SELECT leg, ${FILL_COLUMNS} FROM v2_fills
  WHERE book_id = ? AND client_order_id = ? AND ${CLOSE_LEGS_SQL} ORDER BY rowid`;

const EXIT_ORDER_SQL = `
  SELECT trading_date AS order_date, json_extract(payload, '$.reason') AS reason,
         json_extract(payload, '$.detail') AS detail, json_extract(payload, '$.price') AS trigger
    FROM v2_orders WHERE client_order_id = ? AND leg <> 'entry'`;

const HOLDS_ENTRY_SQL = `SELECT 1 FROM v2_positions
  WHERE book_id = ? AND instrument = ? AND client_order_id = ?`;

const CARRY_SQL = `SELECT COALESCE(SUM(financing_gbp + borrow_gbp), 0) AS carry FROM v2_cfd_carry
  WHERE book_id = ? AND client_order_id = ?`;

const RESCALED_SQL = `SELECT 1 FROM v2_rescales
  WHERE book_id = ? AND instrument = ? AND ratio <> 1 AND trading_date BETWEEN ? AND ?`;

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

type ExitFillRow = OutcomeFill & { readonly leg: string };

type ExitFills = NonEmpty<ExitFillRow>;

type Settlement =
  | { readonly kind: 'settled'; readonly outcome: DecisionOutcome }
  | { readonly kind: 'pending'; readonly reason: PendingReason }
  | { readonly kind: 'unmatched' };

interface Quantities {
  readonly entry: number;
  readonly exit: number;
  readonly rescaled: boolean;
}

function keyOf(bookId: string, exitOrderId: string): string {
  return `${bookId}|${exitOrderId}`;
}

function quantityOf(fills: readonly OutcomeFill[]): number {
  return fills.reduce((sum, fill) => sum + fill.qty, 0);
}

class JournalReader {
  readonly #closedQty = new Map<string, number>();

  constructor(
    private readonly db: StoreHandle,
    private readonly bars: BarsSource,
    closes: readonly CloseRow[],
  ) {
    for (const close of closes) {
      const key = keyOf(close.book_id, close.entry_order_id ?? '');
      this.#closedQty.set(key, (this.#closedQty.get(key) ?? 0) + quantityOf(this.exitFills(close)));
    }
  }

  settle(close: CloseRow): Settlement {
    const entry = this.entryOf(close.entry_order_id);
    if (entry === undefined) return { kind: 'unmatched' };
    if (this.holdsEntry(close, entry)) return { kind: 'pending', reason: 'position_open' };
    const trade = this.trade(close, entry);
    const dates = fillBarsOf(trade, this.bars.load(close.instrument));
    if (dates === undefined) return { kind: 'pending', reason: 'fill_bar' };
    const outcome = outcomeOf(trade, dates, this.bars.load(BENCHMARK_OF_VENUE[entry.venue]));
    return outcome === undefined
      ? { kind: 'pending', reason: 'benchmark_bars' }
      : { kind: 'settled', outcome };
  }

  private exitFills(close: CloseRow): ExitFills {
    return this.db
      .prepare(EXIT_FILLS_SQL)
      .all(close.book_id, close.exit_order_id) as unknown as ExitFills;
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

  private exitOf(close: CloseRow, exitFills: ExitFills): OutcomeExit {
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

  // Each close carries its share of the entry's own quantity, so a stray over-sell cannot spread
  // the entry's cost past its shares; after a split the closes are in new units and only their
  // sum matches the entry
  private exitShareOf(close: CloseRow, entryOrderId: string, quantities: Quantities): number {
    const closed = this.#closedQty.get(keyOf(close.book_id, entryOrderId)) as number;
    return quantities.exit / (quantities.rescaled ? closed : quantities.entry);
  }

  private found(sql: string, ...params: string[]): boolean {
    return this.db.prepare(sql).get(...params) !== undefined;
  }

  private trade(close: CloseRow, entry: OutcomeEntry): ClosedTrade {
    const entryOrderId = entry.entry_order_id;
    const entryFills = this.db
      .prepare(ENTRY_FILLS_SQL)
      .all(entryOrderId) as unknown as NonEmpty<OutcomeFill>;
    const exitFills = this.exitFills(close);
    const exit = this.exitOf(close, exitFills);
    const { carry } = this.db.prepare(CARRY_SQL).get(close.book_id, entryOrderId) as {
      carry: number;
    };
    const { book_id: bookId, instrument } = close;
    const rescaled = this.found(
      RESCALED_SQL,
      bookId,
      instrument,
      entryFills[0].trading_date,
      close.settled_at,
    );
    return {
      bookId,
      instrument,
      entryOrderId,
      exitOrderId: close.exit_order_id,
      settledAt: close.settled_at,
      entry,
      exit,
      entryFills,
      exitFills,
      exitShare: this.exitShareOf(close, entryOrderId, {
        entry: quantityOf(entryFills),
        exit: quantityOf(exitFills),
        rescaled,
      }),
      carryGbp: carry,
      rescaled,
      splitBlocked: this.found(
        SPLIT_BLOCKED_SQL,
        instrument,
        exit.order_date,
        exitFills[0].trading_date,
      ),
    };
  }
}

export function formatOutcomeRebuild(rebuild: OutcomeRebuild): string {
  return [
    `settled ${rebuild.settled} closed trades (${rebuild.written} new)`,
    ...rebuild.pending.map(
      (row) => `pending ${row.bookId} ${row.instrument} ${row.exitOrderId}: ${row.reason}`,
    ),
    ...rebuild.unmatched.map((key) => `unmatched ${key}: no entry decision in the journal`),
  ].join('\n');
}

// An open position or an index bar still to come settles by itself on a later cycle; the rest do not
export function needsAttention(rebuild: OutcomeRebuild): boolean {
  return rebuild.unmatched.length > 0 || rebuild.pending.some((row) => row.reason === 'fill_bar');
}

function writtenKeys(db: StoreHandle): Set<string> {
  const rows = db.prepare(WRITTEN_SQL).all() as { book_id: string; exit_client_order_id: string }[];
  return new Set(rows.map((row) => keyOf(row.book_id, row.exit_client_order_id)));
}

export function rebuildDecisionOutcomes(db: StoreHandle, bars: BarsSource): OutcomeRebuild {
  const closes = db.prepare(CLOSES_SQL).all() as CloseRow[];
  const reader = new JournalReader(db, bars, closes);
  const written = writtenKeys(db);
  const pending: PendingOutcome[] = [];
  const unmatched: string[] = [];
  const fresh: DecisionOutcome[] = [];
  for (const close of closes.filter((row) => !written.has(keyOf(row.book_id, row.exit_order_id)))) {
    const settlement = reader.settle(close);
    if (settlement.kind === 'settled') fresh.push(settlement.outcome);
    else if (settlement.kind === 'unmatched')
      unmatched.push(keyOf(close.book_id, close.exit_order_id));
    else {
      pending.push({
        bookId: close.book_id,
        instrument: close.instrument,
        exitOrderId: close.exit_order_id,
        reason: settlement.reason,
      });
    }
  }
  const insert = db.prepare(INSERT_SQL);
  db.transaction(() => {
    for (const outcome of fresh) insert.run(outcome);
  })();
  return { written: fresh.length, settled: written.size + fresh.length, pending, unmatched };
}
