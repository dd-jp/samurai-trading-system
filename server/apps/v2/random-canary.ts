import type {
  MarketData,
  OrderSide,
  Sleeve,
  SleeveContext,
  SleeveDecision,
  SleeveSpec,
  Venue,
} from '../../../contracts/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import type { FoldRange, WalkForwardPath } from './evidence/index.js';
import { baseRead } from './signal/index.js';

// David, 2026-10-07 on #1747 (ruling 4): 200 runs with fixed seeds
export const RANDOM_CANARY_RUNS = 200;
export const RANDOM_CANARY_FIRST_SEED = 1;
// Awaiting David (#1747): every candidate's own ATR window is 20 bars
export const RANDOM_ENTRY_ATR_WINDOW = 20;
// David, 2026-10-09 on #1747: the redraw bound for the 2026-10-08 re-entry ruling, charged to each
// matched trade's own test fold even when the redraw spills into a later one
export const RANDOM_REENTRY_MAX_DRAWS_PER_FOLD = 1_000;
// David, 2026-10-09 on #1747: a run with at most this share of the path's trades unserved at the
// window's end still counts as matched; a run above it leaves the random band
export const RANDOM_UNSERVED_TOLERANCE = 0.02;

export interface Trade {
  readonly instrument: string;
  readonly venue: Venue;
  readonly side: OrderSide;
  readonly entry: number;
  readonly exit: number | undefined;
}

export interface MatchedTrade {
  readonly trial: number;
  readonly range: FoldRange;
  readonly entry: number;
  readonly venue: Venue;
  readonly side: OrderSide;
  readonly hold: number;
}

export interface ScheduledTrade extends Trade {
  readonly unit: number;
  readonly hold: number;
}

interface FillRow {
  readonly book_id: string;
  readonly trading_date: string;
  readonly instrument: string;
  readonly venue: Venue;
  readonly side: OrderSide;
  readonly qty: number;
}

interface OpenTrade {
  net: number;
  readonly trade: Omit<Trade, 'exit'>;
}

const FLAT_QTY = 1e-9;

function signed(fill: FillRow): number {
  return fill.side === 'buy' ? fill.qty : -fill.qty;
}

function sessionIndex(index: ReadonlyMap<string, number>, date: string): number {
  const at = index.get(date);
  if (at === undefined) throw new Error(`random canary: fill on ${date} is not a session`);
  return at;
}

function applyFill(open: Map<string, OpenTrade>, closed: Trade[], fill: FillRow, at: number): void {
  const held = open.get(fill.instrument);
  if (held === undefined) {
    const { instrument, venue, side } = fill;
    open.set(instrument, { net: signed(fill), trade: { instrument, venue, side, entry: at } });
    return;
  }
  held.net += signed(fill);
  if (Math.abs(held.net) > FLAT_QTY) return;
  open.delete(fill.instrument);
  closed.push({ ...held.trade, exit: at });
}

function tradesFrom(fills: readonly FillRow[], index: ReadonlyMap<string, number>): Trade[] {
  const open = new Map<string, OpenTrade>();
  const closed: Trade[] = [];
  for (const fill of fills) applyFill(open, closed, fill, sessionIndex(index, fill.trading_date));
  const held = [...open.values()].map((row) => ({ ...row.trade, exit: undefined }));
  return [...closed, ...held].sort((a, b) => a.entry - b.entry);
}

export function bookTrades(
  db: StoreHandle,
  bookIds: readonly string[],
  dates: readonly string[],
): Trade[][] {
  const index = new Map(dates.map((date, at) => [date, at]));
  const select = db.prepare(
    `SELECT book_id, trading_date, instrument, venue, side, qty FROM v2_fills
     WHERE book_id = ? ORDER BY fill_seq`,
  );
  return bookIds.map((bookId) => tradesFrom(select.all(bookId) as FillRow[], index));
}

export type EntryOutcome =
  | { readonly kind: 'working' | 'open' | 'refused' }
  | { readonly kind: 'closed'; readonly held: number };

export interface RandomBook {
  outcome(instrument: string, decided: number): EntryOutcome;
}

interface BookFills {
  readonly open: Map<string, OpenTrade>;
  readonly closed: Trade[];
}

interface SeqFillRow extends FillRow {
  readonly fill_seq: number;
}

const WORKING: EntryOutcome = { kind: 'working' };
const OPEN: EntryOutcome = { kind: 'open' };
const REFUSED: EntryOutcome = { kind: 'refused' };

function tradeSince(fills: BookFills, instrument: string, decided: number): Trade | undefined {
  const closed = fills.closed.find((row) => row.instrument === instrument && row.entry >= decided);
  if (closed !== undefined) return closed;
  const open = fills.open.get(instrument)?.trade;
  return open !== undefined && open.entry >= decided ? { ...open, exit: undefined } : undefined;
}

function tradeOutcome(trade: Trade): EntryOutcome {
  return trade.exit === undefined ? OPEN : { kind: 'closed', held: trade.exit - trade.entry };
}

export interface FillLedger {
  attach(db: StoreHandle): void;
  book(bookId: string): RandomBook;
}

interface LedgerStore {
  readonly newer: (seq: number) => SeqFillRow[];
  readonly entry: (bookId: string, instrument: string, date: string) => string | undefined;
}

function ledgerStore(db: StoreHandle): LedgerStore {
  const newer = db.prepare(
    `SELECT fill_seq, book_id, trading_date, instrument, venue, side, qty FROM v2_fills
     WHERE fill_seq > ? ORDER BY fill_seq`,
  );
  const entry = db.prepare(
    `SELECT outcome FROM v2_orders
     WHERE book_id = ? AND instrument = ? AND leg = 'entry' AND trading_date = ?`,
  );
  return {
    newer: (seq) => newer.all(seq) as SeqFillRow[],
    entry: (bookId, instrument, date) =>
      (entry.get(bookId, instrument, date) as { readonly outcome: string } | undefined)?.outcome,
  };
}

export function fillLedger(dates: readonly string[]): FillLedger {
  const index = new Map(dates.map((date, at) => [date, at]));
  const books = new Map<string, BookFills>();
  let store: LedgerStore | undefined;
  let seq = 0;
  const fillsOf = (bookId: string) =>
    memo(books, bookId, (): BookFills => ({ open: new Map(), closed: [] }));
  const attached = (): LedgerStore => {
    if (store === undefined) throw new Error('random canary: the fill ledger has no store');
    for (const row of store.newer(seq)) {
      seq = row.fill_seq;
      const fills = fillsOf(row.book_id);
      applyFill(fills.open, fills.closed, row, sessionIndex(index, row.trading_date));
    }
    return store;
  };
  return {
    attach: (db) => {
      store = ledgerStore(db);
      seq = 0;
      books.clear();
    },
    book: (bookId) => ({
      outcome: (instrument, decided) => {
        const { entry } = attached();
        const trade = tradeSince(fillsOf(bookId), instrument, decided);
        if (trade !== undefined) return tradeOutcome(trade);
        return entry(bookId, instrument, dates[decided] as string) === 'simulated'
          ? WORKING
          : REFUSED;
      },
    }),
  };
}

function inRange(trade: Trade, range: FoldRange): boolean {
  return trade.entry >= range.start && trade.entry < range.end;
}

// David, 2026-10-09 on #1747: a path trade still open at the window's end is held to its last
// session, and its random copy holds exactly that many sessions
export function matchedTrades(
  path: WalkForwardPath,
  trades: readonly (readonly Trade[])[],
  last: number,
): MatchedTrade[] {
  return path.testRanges.flatMap((range, fold) => {
    const trial = path.selectedByFold[fold] as number;
    return (trades[trial] as readonly Trade[])
      .filter((trade) => inRange(trade, range))
      .map((trade) => ({
        trial,
        range,
        entry: trade.entry,
        venue: trade.venue,
        side: trade.side,
        hold: (trade.exit ?? last) - trade.entry,
      }));
  });
}

export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function draw<T>(random: () => number, items: readonly T[]): T | undefined {
  return items[Math.floor(random() * items.length)];
}

export interface EntryRead {
  readonly price: number;
  readonly atr: number;
}

export function entryRead(
  market: MarketData,
  instrument: string,
  tradingDate: string,
): EntryRead | undefined {
  const bars = market.barsBefore(instrument, tradingDate, RANDOM_ENTRY_ATR_WINDOW + 1);
  const read = baseRead(bars, 1, RANDOM_ENTRY_ATR_WINDOW);
  const atr = read?.atr;
  return read === undefined || atr === undefined || !(atr > 0)
    ? undefined
    : { price: read.price, atr };
}

function overlaps(a: Slot, b: Slot): boolean {
  return (
    a.entry <= (b.exit ?? Number.POSITIVE_INFINITY) &&
    b.entry <= (a.exit ?? Number.POSITIVE_INFINITY)
  );
}

export interface ScheduleInput {
  readonly matched: readonly MatchedTrade[];
  readonly folds: readonly FoldRange[];
  readonly dates: readonly string[];
  readonly market: MarketData;
  readonly universe: (trial: number, tradingDate: string) => readonly string[];
}

interface Slot {
  readonly instrument: string;
  readonly entry: number;
  readonly exit: number | undefined;
}

type Occupied = Map<string, Slot[]>;

function free(occupied: Occupied, slot: Slot): boolean {
  return !(occupied.get(slot.instrument) ?? []).some((held) => overlaps(held, slot));
}

function occupy(occupied: Occupied, slot: Slot): void {
  occupied.set(slot.instrument, [...(occupied.get(slot.instrument) ?? []), slot]);
}

function exitOf(entry: number, hold: number, sessions: number): number | undefined {
  const exit = entry + hold;
  return exit < sessions ? exit : undefined;
}

function memo<T>(cache: Map<string, T>, key: string, compute: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  cache.set(key, value);
  return value;
}

type Readable = (trial: number, entry: number) => readonly string[];

function readableBy(input: ScheduleInput): Readable {
  const instruments = new Map<string, readonly string[]>();
  const reads = new Map<string, boolean>();
  const readable = (instrument: string, date: string) =>
    memo(
      reads,
      `${instrument}|${date}`,
      () => entryRead(input.market, instrument, date) !== undefined,
    );
  return (trial, entry) => {
    const date = input.dates[entry] as string;
    return memo(instruments, `${trial}|${entry}`, () =>
      input.universe(trial, date).filter((instrument) => readable(instrument, date)),
    );
  };
}

// David, 2026-10-09 on #1747: a draw may not take a slot that leaves no session to hold. An entry
// decided on a session fills at the next one and is marked at the window's last, so it needs two
// sessions after its decision
const FILL_TO_HELD_SESSION = 2;

function slotsFor(
  input: ScheduleInput,
  readable: Readable,
  trade: MatchedTrade,
  occupied: Occupied,
  from: number,
): Slot[] {
  const slots: Slot[] = [];
  const end = Math.min(trade.range.end, input.dates.length - FILL_TO_HELD_SESSION);
  for (let entry = Math.max(from, trade.range.start); entry < end; entry += 1) {
    const exit = exitOf(entry, trade.hold, input.dates.length);
    for (const instrument of readable(trade.trial, entry)) {
      const slot = { instrument, entry, exit };
      if (free(occupied, slot)) slots.push(slot);
    }
  }
  return slots;
}

function release(occupied: Occupied, trade: ScheduledTrade): void {
  const held = occupied.get(trade.instrument) ?? [];
  occupied.set(
    trade.instrument,
    held.filter((slot) => slot.entry !== trade.entry),
  );
}

export interface RandomDraws {
  readonly schedule: readonly ScheduledTrade[];
  readonly dropped: number;
  redraw(unit: number, hold: number, from: number): ScheduledTrade | undefined;
  release(trade: ScheduledTrade): void;
}

function spillRanges(input: ScheduleInput, home: FoldRange): FoldRange[] {
  return [home, ...input.folds.filter((range) => range.fold > home.fold)];
}

interface DrawState {
  readonly input: ScheduleInput;
  readonly readable: Readable;
  readonly random: () => number;
  readonly occupied: Occupied;
}

function placeDraw(
  { input, readable, random, occupied }: DrawState,
  unit: number,
  hold: number,
  from: number,
): ScheduledTrade | undefined {
  const home = input.matched[unit] as MatchedTrade;
  for (const range of spillRanges(input, home.range)) {
    const trade = { ...home, range, hold };
    const slot = draw(random, slotsFor(input, readable, trade, occupied, from));
    if (slot === undefined) continue;
    occupy(occupied, slot);
    return { ...slot, venue: home.venue, side: home.side, unit, hold };
  }
  return undefined;
}

// Awaiting David (#1747): each matched trade is drawn uniformly over the free (session,
// instrument) slots of its own test fold, from its trial's universe. David, 2026-10-09 on #1747:
// a draw with no free slot left in its fold spills into the next fold, and so on to the last;
// only a draw that finds none there leaves its run unmatched
export function randomScheduler(input: ScheduleInput): (seed: number) => RandomDraws {
  const readable = readableBy(input);
  return (seed) => {
    const random = seededRandom(seed);
    const occupied: Occupied = new Map();
    const draws = new Map<number, number>();
    const place = (unit: number, hold: number, from: number) =>
      placeDraw({ input, readable, random, occupied }, unit, hold, from);
    const schedule = input.matched.flatMap(
      (trade, unit) => place(unit, trade.hold, trade.range.start) ?? [],
    );
    return {
      schedule,
      dropped: input.matched.length - schedule.length,
      redraw: (unit, hold, from) => {
        const fold = (input.matched[unit] as MatchedTrade).range.fold;
        const used = draws.get(fold) ?? 0;
        if (used >= RANDOM_REENTRY_MAX_DRAWS_PER_FOLD) return undefined;
        draws.set(fold, used + 1);
        return place(unit, hold, from);
      },
      release: (trade) => release(occupied, trade),
    };
  };
}

function entryDecision(
  sleeve: string,
  spec: SleeveSpec,
  trade: ScheduledTrade,
  read: EntryRead,
): SleeveDecision {
  const long = trade.side === 'buy';
  const distance = spec.sizing.stopAtrMultiple * read.atr;
  return {
    sleeve_id: sleeve,
    instrument: trade.instrument,
    venue: trade.venue,
    direction: long ? 'bullish' : 'bearish',
    confidence: 1,
    action: long ? 'enter_long' : 'enter_short',
    reason: 'random entry',
    price: read.price,
    atr: read.atr,
    stop_price: long ? read.price - distance : read.price + distance,
    inputs_hash: `${sleeve}-${trade.instrument}-${trade.entry}`,
    debate_id: undefined,
    payload: {},
  };
}

function exitDecision(sleeve: string, trade: ScheduledTrade, at: number): SleeveDecision {
  return {
    sleeve_id: sleeve,
    instrument: trade.instrument,
    venue: trade.venue,
    direction: 'neutral',
    confidence: 1,
    action: 'exit',
    reason: 'random hold elapsed',
    price: 0,
    atr: undefined,
    stop_price: undefined,
    inputs_hash: `${sleeve}-${trade.instrument}-${at}`,
    debate_id: undefined,
    payload: {},
  };
}

export interface RandomSleeveInput {
  readonly id: string;
  readonly spec: SleeveSpec;
  readonly draws: RandomDraws;
  readonly dates: readonly string[];
  readonly book: RandomBook;
}

export interface RandomRunReport {
  readonly scheduled: number;
  readonly redraws: number;
  readonly unmatched: number;
}

export interface RandomSleeve extends Sleeve {
  report(): RandomRunReport;
}

interface Attempt {
  readonly trade: ScheduledTrade;
  exitSent: boolean;
}

type Quote = (instrument: string) => EntryRead | undefined;

function unservedHold(attempt: Attempt, held: number | undefined, last: number): number | null {
  const { hold, entry } = attempt.trade;
  if (held === undefined) return hold;
  if (attempt.exitSent || held >= Math.min(hold, last - entry - 1)) return null;
  return hold - held;
}

// David, 2026-10-08 and 2026-10-09 on #1747: after an early exit or a refused or zero-size entry
// the run draws a new slot for the hold still unserved, in the same fold or spilling into later
// ones, until the walk-forward path's trades and held sessions are matched; a run over the
// unserved tolerance at the window's end leaves the random band
class RandomRunState {
  readonly #input: RandomSleeveInput;
  readonly #pending = new Map<number, ScheduledTrade[]>();
  #live: Attempt[] = [];
  #redraws = 0;
  #unmatched = 0;

  constructor(input: RandomSleeveInput) {
    this.#input = input;
    for (const trade of input.draws.schedule) this.#queue(trade);
  }

  report(): RandomRunReport {
    return {
      scheduled: this.#input.draws.schedule.length,
      redraws: this.#redraws,
      unmatched: this.#input.draws.dropped + this.#unmatched,
    };
  }

  instruments(): string[] {
    const trades = [...[...this.#pending.values()].flat(), ...this.#live.map((row) => row.trade)];
    return [...new Set(trades.map((trade) => trade.instrument))];
  }

  decide(at: number, quote: Quote): SleeveDecision[] {
    const exits = [...this.#live].flatMap((attempt) => this.#settle(attempt, at));
    return [...exits, ...this.#enter(at, quote)];
  }

  #queue(trade: ScheduledTrade): void {
    this.#pending.set(trade.entry, [...(this.#pending.get(trade.entry) ?? []), trade]);
  }

  #redraw(trade: ScheduledTrade, hold: number, from: number): void {
    this.#redraws += 1;
    const next = this.#input.draws.redraw(trade.unit, hold, from);
    if (next === undefined) this.#unmatched += 1;
    else this.#queue(next);
  }

  #settle(attempt: Attempt, at: number): SleeveDecision[] {
    const { trade } = attempt;
    const outcome = this.#input.book.outcome(trade.instrument, trade.entry);
    if (outcome.kind === 'working') return [];
    if (outcome.kind === 'open') return this.#exitDue(attempt, at);
    this.#live = this.#live.filter((row) => row !== attempt);
    this.#input.draws.release(trade);
    const held = outcome.kind === 'closed' ? outcome.held : undefined;
    const hold = unservedHold(attempt, held, this.#input.dates.length - 1);
    if (hold !== null) this.#redraw(trade, hold, at);
    return [];
  }

  #exitDue(attempt: Attempt, at: number): SleeveDecision[] {
    const { exit } = attempt.trade;
    if (attempt.exitSent || exit === undefined || at < exit) return [];
    attempt.exitSent = true;
    return [exitDecision(this.#input.id, attempt.trade, at)];
  }

  #enter(at: number, quote: Quote): SleeveDecision[] {
    const today = this.#pending.get(at) ?? [];
    this.#pending.delete(at);
    return today.flatMap((trade) => {
      const read = quote(trade.instrument);
      if (read === undefined) {
        this.#input.draws.release(trade);
        this.#redraw(trade, trade.hold, at + 1);
        return [];
      }
      this.#live.push({ trade, exitSent: false });
      return [entryDecision(this.#input.id, this.#input.spec, trade, read)];
    });
  }
}

export function randomEntrySleeve(input: RandomSleeveInput, market: MarketData): RandomSleeve {
  const index = new Map(input.dates.map((date, at) => [date, at]));
  const run = new RandomRunState(input);
  return {
    id: input.id,
    spec: input.spec,
    report: () => run.report(),
    universe: () => ({ instruments: run.instruments(), refusals: [] }),
    decide: (context: SleeveContext) => {
      const at = index.get(context.tradingDate);
      const quote = (instrument: string) => entryRead(market, instrument, context.tradingDate);
      return Promise.resolve({
        decisions: at === undefined ? [] : run.decide(at, quote),
        refusals: [],
      });
    },
  };
}

// David, 2026-10-09 on #1747: a position still open at the window's end, random or the path's own,
// is marked at its last session, so its hold is cut there and still counts
export function sessionsHeld(
  trades: readonly { readonly entry: number; readonly exit: number | undefined }[],
  last: number,
): number {
  return trades.reduce((total, trade) => total + (trade.exit ?? last) - trade.entry, 0);
}

export function matchedSessions(matched: readonly MatchedTrade[]): number {
  return matched.reduce((total, trade) => total + trade.hold, 0);
}

export function servedWithinTolerance(unmatched: number, matched: number): boolean {
  return unmatched <= RANDOM_UNSERVED_TOLERANCE * matched;
}
