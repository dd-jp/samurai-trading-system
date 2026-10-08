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
  readonly venue: Venue;
  readonly side: OrderSide;
  readonly hold: number | undefined;
}

export type ScheduledTrade = Trade;

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

function inRange(trade: Trade, range: FoldRange): boolean {
  return trade.entry >= range.start && trade.entry < range.end;
}

export function matchedTrades(
  path: WalkForwardPath,
  trades: readonly (readonly Trade[])[],
): MatchedTrade[] {
  return path.testRanges.flatMap((range, fold) => {
    const trial = path.selectedByFold[fold] as number;
    return (trades[trial] as readonly Trade[])
      .filter((trade) => inRange(trade, range))
      .map((trade) => ({
        trial,
        range,
        venue: trade.venue,
        side: trade.side,
        hold: trade.exit === undefined ? undefined : trade.exit - trade.entry,
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

function exitOf(entry: number, hold: number | undefined, sessions: number): number | undefined {
  if (hold === undefined) return undefined;
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

function slotsFor(
  input: ScheduleInput,
  readable: Readable,
  trade: MatchedTrade,
  occupied: Occupied,
): Slot[] {
  const slots: Slot[] = [];
  for (let entry = trade.range.start; entry < trade.range.end; entry += 1) {
    const exit = exitOf(entry, trade.hold, input.dates.length);
    for (const instrument of readable(trade.trial, entry)) {
      const slot = { instrument, entry, exit };
      if (free(occupied, slot)) slots.push(slot);
    }
  }
  return slots;
}

// Awaiting David (#1747): each matched trade is redrawn uniformly over the free (session,
// instrument) slots of its own test fold, from its trial's universe; a trade with no free slot
// is dropped and the run logs how many it scheduled
export function randomScheduler(input: ScheduleInput): (seed: number) => ScheduledTrade[] {
  const readable = readableBy(input);
  return (seed) => {
    const random = seededRandom(seed);
    const occupied: Occupied = new Map();
    const schedule: ScheduledTrade[] = [];
    for (const trade of input.matched) {
      const slot = draw(random, slotsFor(input, readable, trade, occupied));
      if (slot === undefined) continue;
      occupy(occupied, slot);
      schedule.push({ ...slot, venue: trade.venue, side: trade.side });
    }
    return schedule;
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

function exitDecision(sleeve: string, trade: ScheduledTrade): SleeveDecision {
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
    inputs_hash: `${sleeve}-${trade.instrument}-${trade.exit}`,
    debate_id: undefined,
    payload: {},
  };
}

function decisionsOn(
  sleeve: string,
  spec: SleeveSpec,
  schedule: readonly ScheduledTrade[],
  at: number,
  read: (instrument: string) => EntryRead | undefined,
): SleeveDecision[] {
  const exits = schedule.filter((trade) => trade.exit === at).map((t) => exitDecision(sleeve, t));
  const entries = schedule.flatMap((trade) => {
    const quote = trade.entry === at ? read(trade.instrument) : undefined;
    return quote === undefined ? [] : [entryDecision(sleeve, spec, trade, quote)];
  });
  return [...exits, ...entries];
}

export interface RandomSleeveInput {
  readonly id: string;
  readonly spec: SleeveSpec;
  readonly schedule: readonly ScheduledTrade[];
  readonly dates: readonly string[];
}

export function randomEntrySleeve(input: RandomSleeveInput, market: MarketData): Sleeve {
  const index = new Map(input.dates.map((date, at) => [date, at]));
  const instruments = [...new Set(input.schedule.map((trade) => trade.instrument))];
  return {
    id: input.id,
    spec: input.spec,
    universe: () => ({ instruments, refusals: [] }),
    decide: (context: SleeveContext) => {
      const at = index.get(context.tradingDate) ?? -1;
      const read = (instrument: string) => entryRead(market, instrument, context.tradingDate);
      return Promise.resolve({
        decisions: decisionsOn(input.id, input.spec, input.schedule, at, read),
        refusals: [],
      });
    },
  };
}

export function sessionsHeld(
  trades: readonly { readonly entry: number; readonly exit: number | undefined }[],
): number {
  return trades.reduce(
    (total, trade) => total + (trade.exit === undefined ? 0 : trade.exit - trade.entry),
    0,
  );
}

export function matchedSessions(matched: readonly MatchedTrade[]): number {
  return matched.reduce((total, trade) => total + (trade.hold ?? 0), 0);
}
