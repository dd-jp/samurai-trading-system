import { describe, expect, it } from 'vitest';
import type { SleeveSpec } from '../../../contracts/index.js';
import type { BarSeries, DailyBar } from '../../shared/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { BarsMarketData, parseBoeGbpUsdCsv } from './data/index.js';
import type { FoldRange, WalkForwardPath } from './evidence/index.js';
import {
  bookTrades,
  type EntryOutcome,
  entryRead,
  fillLedger,
  type MatchedTrade,
  matchedSessions,
  matchedTrades,
  RANDOM_CANARY_FIRST_SEED,
  RANDOM_CANARY_RUNS,
  RANDOM_ENTRY_ATR_WINDOW,
  RANDOM_REENTRY_MAX_DRAWS_PER_FOLD,
  RANDOM_UNSERVED_TOLERANCE,
  type RandomBook,
  type RandomDraws,
  randomEntrySleeve,
  randomScheduler,
  type ScheduledTrade,
  type ScheduleInput,
  seededRandom,
  servedWithinTolerance,
  sessionsHeld,
} from './random-canary.js';

function weekdays(from: string, count: number): string[] {
  const dates: string[] = [];
  for (let ms = Date.parse(`${from}T00:00:00.000Z`); dates.length < count; ms += 86_400_000) {
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

const DATES = weekdays('2024-01-01', 80);

function series(symbol: string, from: number): BarSeries {
  const bars: DailyBar[] = DATES.slice(from).map((date, index) => {
    const close = 100 + index;
    return {
      date,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000,
      rawClose: close * 2,
    };
  });
  return { symbol, bars };
}

const BARS = new Map<string, BarSeries>([
  ['A', series('A', 0)],
  ['B', series('B', 0)],
  ['LATE', series('LATE', 60)],
]);
const market = new BarsMarketData(
  { load: (symbol) => BARS.get(symbol) },
  parseBoeGbpUsdCsv('DATE,XUDLUSS\n29 Dec 2023,1.27\n'),
);

const SPEC: SleeveSpec = {
  capitalShare: 1,
  minimumCapitalGbp: 0,
  capacityGbp: Number.POSITIVE_INFINITY,
  validation: 'backtest',
  macroGate: false,
  sizing: {
    riskFraction: 0.01,
    stopAtrMultiple: 3,
    targetAtrMultiple: 4,
    timeStopTradingDays: 50,
    advShare: 0.01,
    advWindowBars: 20,
  },
  books: [{ variant: 'primary', instantiated: true }],
};

function matched(overrides: Partial<MatchedTrade> = {}): MatchedTrade {
  return {
    trial: 0,
    range: { fold: 1, start: 30, end: 50 },
    entry: 30,
    venue: 'saxo',
    side: 'buy',
    hold: 5,
    ...overrides,
  };
}

function schedule(
  trades: readonly MatchedTrade[],
  universe = ['A', 'B', 'LATE'],
  folds: readonly FoldRange[] = [],
): ScheduleInput {
  return { matched: trades, folds, dates: DATES, market, universe: () => universe };
}

describe('constants', () => {
  it('declares 200 seeded runs from seed 1, a 20-bar entry ATR and 1,000 redraws a fold', () => {
    expect(RANDOM_REENTRY_MAX_DRAWS_PER_FOLD).toBe(1_000);
    expect(RANDOM_CANARY_RUNS).toBe(200);
    expect(RANDOM_CANARY_FIRST_SEED).toBe(1);
    expect(RANDOM_ENTRY_ATR_WINDOW).toBe(20);
  });
});

describe('servedWithinTolerance', () => {
  it(`counts a run as matched with at most ${RANDOM_UNSERVED_TOLERANCE * 100}% of the path's trades unserved`, () => {
    expect(RANDOM_UNSERVED_TOLERANCE).toBe(0.02);
    expect(servedWithinTolerance(0, 0)).toBe(true);
    expect(servedWithinTolerance(1, 50)).toBe(true);
    expect(servedWithinTolerance(1, 49)).toBe(false);
    expect(servedWithinTolerance(2, 100)).toBe(true);
    expect(servedWithinTolerance(3, 100)).toBe(false);
    expect(servedWithinTolerance(10, 548)).toBe(true);
    expect(servedWithinTolerance(11, 548)).toBe(false);
  });
});

describe('seededRandom', () => {
  it('repeats a seed exactly and stays in [0, 1)', () => {
    const first = Array.from({ length: 50 }, seededRandom(7));
    const again = Array.from({ length: 50 }, seededRandom(7));
    const other = Array.from({ length: 50 }, seededRandom(8));
    expect(first).toEqual(again);
    expect(first).not.toEqual(other);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});

describe('entryRead', () => {
  it('quotes the last raw close with a raw-terms ATR, and nothing short of the window', () => {
    const read = entryRead(market, 'A', DATES[30] as string);
    expect(read?.price).toBe((100 + 29) * 2);
    expect(read?.atr).toBeCloseTo(2 * 2, 9);
    expect(entryRead(market, 'A', DATES[20] as string)).toBeUndefined();
    expect(entryRead(market, 'NONE', DATES[30] as string)).toBeUndefined();
  });

  it('refuses a flat window with no range', () => {
    const flat: BarSeries = {
      symbol: 'FLAT',
      bars: DATES.map((date) => ({
        date,
        open: 5,
        high: 5,
        low: 5,
        close: 5,
        volume: 1,
        rawClose: 5,
      })),
    };
    const flatMarket = new BarsMarketData(
      { load: (symbol) => (symbol === 'FLAT' ? flat : undefined) },
      parseBoeGbpUsdCsv('DATE,XUDLUSS\n29 Dec 2023,1.27\n'),
    );
    expect(entryRead(flatMarket, 'FLAT', DATES[40] as string)).toBeUndefined();
  });
});

describe('matchedTrades', () => {
  const path: WalkForwardPath = {
    returns: [],
    start: 10,
    end: 30,
    selectedByFold: [1, 0],
    testRanges: [
      { fold: 1, start: 10, end: 20 },
      { fold: 2, start: 20, end: 30 },
    ],
  };

  it("takes each fold's trades from the trial it selected, by entry session", () => {
    const trades = [
      [
        { instrument: 'A', venue: 'saxo' as const, side: 'buy' as const, entry: 12, exit: 14 },
        { instrument: 'B', venue: 'saxo' as const, side: 'sell' as const, entry: 25, exit: 29 },
        {
          instrument: 'A',
          venue: 'saxo' as const,
          side: 'buy' as const,
          entry: 28,
          exit: undefined,
        },
      ],
      [
        { instrument: 'A', venue: 'alpaca' as const, side: 'buy' as const, entry: 9, exit: 11 },
        { instrument: 'B', venue: 'alpaca' as const, side: 'buy' as const, entry: 19, exit: 23 },
        { instrument: 'B', venue: 'alpaca' as const, side: 'buy' as const, entry: 20, exit: 21 },
      ],
    ];
    const rows = matchedTrades(path, trades);
    expect(rows).toEqual([
      { trial: 1, range: path.testRanges[0], entry: 19, venue: 'alpaca', side: 'buy', hold: 4 },
      { trial: 0, range: path.testRanges[1], entry: 25, venue: 'saxo', side: 'sell', hold: 4 },
      {
        trial: 0,
        range: path.testRanges[1],
        entry: 28,
        venue: 'saxo',
        side: 'buy',
        hold: undefined,
      },
    ]);
  });

  it('marks a trade still open at the window end at its last session', () => {
    const trades = [
      { entry: 12, exit: 14 },
      { entry: 25, exit: 29 },
      { entry: 28, exit: undefined },
    ];
    expect(sessionsHeld(trades, 30)).toBe(8);
    expect(sessionsHeld(trades, 31)).toBe(9);
    const rows = [matched({ entry: 19, hold: 4 }), matched({ entry: 28, hold: undefined })];
    expect(matchedSessions(rows, 30)).toBe(6);
    expect(matchedSessions(rows, 31)).toBe(7);
  });
});

function noOverlap(rows: readonly ScheduledTrade[]): boolean {
  return rows.every((a, i) =>
    rows.every(
      (b, j) =>
        i === j ||
        a.instrument !== b.instrument ||
        (a.exit ?? Number.POSITIVE_INFINITY) < b.entry ||
        (b.exit ?? Number.POSITIVE_INFINITY) < a.entry,
    ),
  );
}

describe('randomScheduler', () => {
  it('keeps the trade count, side, venue and hold, inside each fold, on a readable free name', () => {
    const trades = [
      matched(),
      matched({ side: 'sell', venue: 'alpaca', hold: 3 }),
      matched({ range: { fold: 2, start: 50, end: 70 }, hold: 8 }),
      ...Array.from({ length: 3 }, () => matched({ hold: 2 })),
    ];
    const rows = randomScheduler(schedule(trades))(3).schedule;
    expect(rows).toHaveLength(trades.length);
    rows.forEach((row, index) => {
      const trade = trades[index] as MatchedTrade;
      expect(row.side).toBe(trade.side);
      expect(row.venue).toBe(trade.venue);
      expect(row.exit).toBe(row.entry + (trade.hold as number));
      expect(row.unit).toBe(index);
      expect(row.hold).toBe(trade.hold);
      expect(row.entry).toBeGreaterThanOrEqual(trade.range.start);
      expect(row.entry).toBeLessThan(trade.range.end);
      expect(entryRead(market, row.instrument, DATES[row.entry] as string)).toBeDefined();
    });
    expect(noOverlap(rows)).toBe(true);
    expect(rows.some((row) => row.instrument === 'LATE')).toBe(false);
  });

  it('repeats a seed and moves with another', () => {
    const trades = Array.from({ length: 6 }, () => matched({ hold: 2 }));
    const scheduler = randomScheduler(schedule(trades));
    expect(scheduler(1).schedule).toEqual(scheduler(1).schedule);
    expect(scheduler(1).schedule).not.toEqual(scheduler(2).schedule);
  });

  it('holds an open trade, or one whose exit falls past the window, to the end and drops a trade with no free slot', () => {
    const late = { fold: 3, start: 75, end: 76 };
    const trades = [
      matched({ range: late, hold: undefined }),
      matched({ range: late, hold: 30 }),
      matched({ range: late, hold: 1 }),
    ];
    const draws = randomScheduler(schedule(trades, ['A', 'B']))(5);
    const rows = draws.schedule;
    expect(rows).toHaveLength(2);
    expect(draws.dropped).toBe(1);
    expect(rows.map((row) => row.exit)).toEqual([undefined, undefined]);
    expect(new Set(rows.map((row) => row.instrument))).toEqual(new Set(['A', 'B']));
  });

  it('draws from the universe of the trial that made the trade', () => {
    const seen: [number, string][] = [];
    const input: ScheduleInput = {
      matched: [matched({ trial: 1 })],
      folds: [],
      dates: DATES,
      market,
      universe: (trial, date) => {
        seen.push([trial, date]);
        return trial === 1 ? ['B'] : ['A'];
      },
    };
    expect(randomScheduler(input)(9).schedule.map((row) => row.instrument)).toEqual(['B']);
    expect(new Set(seen.map(([trial]) => trial))).toEqual(new Set([1]));
  });
});

describe('randomScheduler redraws', () => {
  const fold = { fold: 1, start: 30, end: 50 };

  it('redraws a unit inside its fold from the given session, on a slot left free', () => {
    const draws = randomScheduler(schedule([matched({ range: fold, hold: 5 })], ['A', 'B']))(4);
    const next = draws.redraw(0, 3, 45) as ScheduledTrade;
    expect(next).toMatchObject({ unit: 0, hold: 3, venue: 'saxo', side: 'buy' });
    expect(next.entry).toBeGreaterThanOrEqual(45);
    expect(next.entry).toBeLessThan(50);
    expect(next.exit).toBe(next.entry + 3);
    expect(noOverlap([...draws.schedule, next])).toBe(true);
  });

  it('frees a released slot and finds none in a full fold', () => {
    const tight = { fold: 2, start: 40, end: 41 };
    const draws = randomScheduler(schedule([matched({ range: tight, hold: 2 })], ['A']))(2);
    const first = draws.schedule[0] as ScheduledTrade;
    expect(draws.redraw(0, 2, 40)).toBeUndefined();
    draws.release(first);
    expect(draws.redraw(0, 2, 40)).toMatchObject({ instrument: 'A', entry: 40, exit: 42 });
    expect(draws.redraw(0, 2, 41)).toBeUndefined();
  });

  it(`stops a fold at ${RANDOM_REENTRY_MAX_DRAWS_PER_FOLD} redraws and leaves the other folds drawing`, () => {
    const other = { fold: 2, start: 50, end: 70 };
    const draws = randomScheduler(
      schedule([matched({ range: fold, hold: 1 }), matched({ range: other, hold: 1 })], ['A', 'B']),
    )(6);
    const placed = Array.from({ length: RANDOM_REENTRY_MAX_DRAWS_PER_FOLD }, () => {
      const row = draws.redraw(0, 1, 30);
      if (row !== undefined) draws.release(row);
      return row;
    });
    expect(placed.every((row) => row !== undefined)).toBe(true);
    expect(draws.redraw(0, 1, 30)).toBeUndefined();
    expect(draws.redraw(1, 1, 50)).toBeDefined();
  });
});

describe('randomScheduler spills', () => {
  const tight = { fold: 1, start: 30, end: 31 };
  const empty = { fold: 2, start: 31, end: 31 };
  const next = { fold: 3, start: 40, end: 45 };
  const earlier = { fold: 0, start: 20, end: 30 };
  const folds = [earlier, tight, empty, next];

  it('places a trade with no free slot left in its fold in the next fold that has one', () => {
    const trades = [matched({ range: tight, hold: 2 }), matched({ range: tight, hold: 2 })];
    const draws = randomScheduler(schedule(trades, ['A'], folds))(7);
    expect(draws.dropped).toBe(0);
    const [home, spilled] = draws.schedule as [ScheduledTrade, ScheduledTrade];
    expect(home).toMatchObject({ unit: 0, instrument: 'A', entry: 30, exit: 32 });
    expect(spilled).toMatchObject({
      unit: 1,
      instrument: 'A',
      venue: 'saxo',
      side: 'buy',
      hold: 2,
    });
    expect(spilled.entry).toBeGreaterThanOrEqual(next.start);
    expect(spilled.entry).toBeLessThan(next.end);
    expect(noOverlap(draws.schedule)).toBe(true);
  });

  it('spills a redraw past its fold from the given session, never back into an earlier fold', () => {
    const draws = randomScheduler(schedule([matched({ range: tight, hold: 1 })], ['A'], folds))(3);
    const row = draws.redraw(0, 1, 42) as ScheduledTrade;
    expect(row.entry).toBeGreaterThanOrEqual(42);
    expect(row.entry).toBeLessThan(next.end);
    expect(draws.redraw(0, 1, next.end)).toBeUndefined();
  });

  it('leaves a trade unmatched only when no fold to the end of the window has a free slot', () => {
    const last = { fold: 3, start: 40, end: 41 };
    const trades = Array.from({ length: 3 }, () => matched({ range: tight, hold: 20 }));
    const draws = randomScheduler(schedule(trades, ['A'], [tight, last]))(5);
    expect(draws.schedule.map((row) => row.entry)).toEqual([30]);
    expect(draws.dropped).toBe(2);
  });

  it('spills only into folds after its own, whatever else the fold list holds', () => {
    const trades = Array.from({ length: 6 }, () => matched({ range: tight, hold: 1 }));
    const rows = (list: readonly FoldRange[]) =>
      randomScheduler(schedule(trades, ['A', 'B'], list))(13).schedule;
    expect(rows(folds)).toEqual(rows([empty, next]));
  });

  it('repeats a seed exactly with spills and moves with another', () => {
    const trades = Array.from({ length: 6 }, () => matched({ range: tight, hold: 1 }));
    const scheduler = randomScheduler(schedule(trades, ['A', 'B'], folds));
    const run = (seed: number) => {
      const draws = scheduler(seed);
      return [...draws.schedule, draws.redraw(0, 1, 40), draws.redraw(1, 1, 40)];
    };
    expect(run(11)).toEqual(run(11));
    expect(run(11)).not.toEqual(run(12));
  });
});

interface Calls {
  readonly redraws: [number, number | undefined, number][];
  readonly released: ScheduledTrade[];
}

function fakeDraws(
  rows: readonly ScheduledTrade[],
  next: (unit: number, hold: number | undefined, from: number) => ScheduledTrade | undefined,
  dropped = 0,
): RandomDraws & Calls {
  const redraws: [number, number | undefined, number][] = [];
  const released: ScheduledTrade[] = [];
  return {
    schedule: rows,
    dropped,
    redraws,
    released,
    redraw: (unit, hold, from) => {
      redraws.push([unit, hold, from]);
      return next(unit, hold, from);
    },
    release: (trade) => {
      released.push(trade);
    },
  };
}

function scheduled(overrides: Partial<ScheduledTrade> = {}): ScheduledTrade {
  return {
    instrument: 'A',
    venue: 'saxo',
    side: 'buy',
    entry: 30,
    exit: 33,
    unit: 0,
    hold: 3,
    ...overrides,
  };
}

function fakeBook(outcomes: Map<string, EntryOutcome>): RandomBook {
  return { outcome: (instrument, decided) => outcomes.get(`${instrument}@${decided}`) ?? WORKING };
}

const WORKING: EntryOutcome = { kind: 'working' };
const OPEN: EntryOutcome = { kind: 'open' };
const REFUSED: EntryOutcome = { kind: 'refused' };

function harness(
  rows: readonly ScheduledTrade[],
  next: (unit: number, hold: number | undefined, from: number) => ScheduledTrade | undefined = () =>
    undefined,
  dropped = 0,
) {
  const outcomes = new Map<string, EntryOutcome>();
  const draws = fakeDraws(rows, next, dropped);
  const sleeve = randomEntrySleeve(
    { id: 'c-random-1', spec: SPEC, draws, dates: DATES, book: fakeBook(outcomes) },
    market,
  );
  const decide = async (at: number) =>
    (await sleeve.decide({ tradingDate: DATES[at] as string, macroDay: false, dryRun: true }, []))
      .decisions;
  const actions = async (at: number) =>
    (await decide(at)).map((row) => [row.instrument, row.action, row.inputs_hash]);
  const set = (instrument: string, decided: number, outcome: EntryOutcome) =>
    outcomes.set(`${instrument}@${decided}`, outcome);
  return { sleeve, draws, decide, actions, set };
}

describe('randomEntrySleeve', () => {
  it('carries its spec and lists the names it has scheduled or holds', async () => {
    const { sleeve, decide } = harness([
      scheduled(),
      scheduled({ instrument: 'B', entry: 33, exit: undefined, unit: 1, hold: undefined }),
    ]);
    const universe = () =>
      sleeve.universe({ tradingDate: DATES[0] as string, macroDay: false, dryRun: true });
    expect(sleeve.id).toBe('c-random-1');
    expect(sleeve.spec).toBe(SPEC);
    expect(universe()).toEqual({ instruments: ['A', 'B'], refusals: [] });
    await decide(30);
    expect(universe().instruments).toEqual(['B', 'A']);
  });

  it('enters at the quoted close with the spec stop and exits an open trade once its hold has run', async () => {
    const run = harness([
      scheduled(),
      scheduled({
        instrument: 'B',
        venue: 'alpaca',
        side: 'sell',
        entry: 33,
        exit: undefined,
        unit: 1,
        hold: undefined,
      }),
    ]);
    const entry = await run.decide(30);
    const read = entryRead(market, 'A', DATES[30] as string);
    expect(entry).toEqual([
      expect.objectContaining({
        sleeve_id: 'c-random-1',
        instrument: 'A',
        venue: 'saxo',
        direction: 'bullish',
        action: 'enter_long',
        price: read?.price,
        atr: read?.atr,
        stop_price: (read?.price as number) - 3 * (read?.atr as number),
        inputs_hash: 'c-random-1-A-30',
      }),
    ]);
    expect(await run.decide(31)).toEqual([]);
    run.set('A', 30, OPEN);
    expect(await run.decide(32)).toEqual([]);
    const swap = await run.decide(33);
    const short = entryRead(market, 'B', DATES[33] as string);
    expect(swap.map((row) => [row.instrument, row.action, row.inputs_hash])).toEqual([
      ['A', 'exit', 'c-random-1-A-33'],
      ['B', 'enter_short', 'c-random-1-B-33'],
    ]);
    expect(swap[0]).toMatchObject({ venue: 'saxo', direction: 'neutral', price: 0 });
    expect(swap[1]?.direction).toBe('bearish');
    expect(swap[1]?.stop_price).toBe((short?.price as number) + 3 * (short?.atr as number));
    expect(await run.actions(34)).toEqual([]);
    run.set('A', 30, { kind: 'closed', held: 3 });
    expect(await run.actions(35)).toEqual([]);
    expect(run.draws.redraws).toEqual([]);
    expect(run.draws.released).toEqual([scheduled()]);
    expect(run.sleeve.report()).toEqual({ scheduled: 2, redraws: 0, unmatched: 0 });
  });

  it('exits a trade still open past its hold, once', async () => {
    const run = harness([scheduled()]);
    await run.decide(30);
    expect(await run.actions(33)).toEqual([]);
    run.set('A', 30, OPEN);
    expect(await run.actions(34)).toEqual([['A', 'exit', 'c-random-1-A-34']]);
    expect(await run.actions(35)).toEqual([]);
  });

  it('sends no exit for a trade its stop has already closed, and redraws the unserved hold', async () => {
    const again = scheduled({ instrument: 'B', entry: 32, exit: 34, hold: 2 });
    const run = harness([scheduled()], () => again);
    await run.decide(30);
    run.set('A', 30, { kind: 'closed', held: 1 });
    expect(await run.actions(32)).toEqual([['B', 'enter_long', 'c-random-1-B-32']]);
    expect(run.draws.redraws).toEqual([[0, 2, 32]]);
    expect(run.draws.released).toEqual([scheduled()]);
    expect(await run.actions(33)).toEqual([]);
    run.set('B', 32, OPEN);
    expect(await run.actions(34)).toEqual([['B', 'exit', 'c-random-1-B-34']]);
    expect(run.sleeve.report()).toEqual({ scheduled: 1, redraws: 1, unmatched: 0 });
  });

  it('redraws a refused entry for its whole hold and an open-ended trade for the rest of the window', async () => {
    const run = harness([
      scheduled(),
      scheduled({ instrument: 'B', exit: undefined, unit: 1, hold: undefined }),
    ]);
    await run.decide(30);
    run.set('A', 30, REFUSED);
    run.set('B', 30, { kind: 'closed', held: 4 });
    await run.decide(36);
    expect(run.draws.redraws).toEqual([
      [0, 3, 36],
      [1, undefined, 36],
    ]);
    expect(run.sleeve.report()).toEqual({ scheduled: 2, redraws: 2, unmatched: 2 });
  });

  it('redraws a hold cut at the window end only while sessions before the end are unserved', async () => {
    const cut = scheduled({ entry: 75, exit: undefined, hold: 10 });
    const run = harness([
      cut,
      scheduled({ instrument: 'B', entry: 75, exit: undefined, unit: 1, hold: 10 }),
    ]);
    await run.decide(75);
    run.set('A', 75, { kind: 'closed', held: 4 });
    run.set('B', 75, { kind: 'closed', held: 3 });
    await run.decide(79);
    expect(run.draws.redraws).toEqual([[1, 7, 79]]);
  });

  it('counts a trade served in full as matched without a redraw', async () => {
    const run = harness([scheduled({ exit: undefined, hold: 3 })]);
    await run.decide(30);
    run.set('A', 30, { kind: 'closed', held: 3 });
    await run.decide(34);
    expect(run.draws.redraws).toEqual([]);
    expect(run.draws.released).toHaveLength(1);
  });

  it('redraws an entry it cannot quote from the next session and counts drops as unmatched', async () => {
    const late = scheduled({ instrument: 'LATE', entry: 30, exit: 31, hold: 1 });
    const run = harness([late], () => undefined, 2);
    expect(await run.decide(30)).toEqual([]);
    expect(run.draws.redraws).toEqual([[0, 1, 31]]);
    expect(run.draws.released).toEqual([late]);
    expect(run.sleeve.report()).toEqual({ scheduled: 1, redraws: 1, unmatched: 3 });
  });

  it('keeps a working entry and decides nothing on a date outside the run', async () => {
    const run = harness([scheduled()]);
    await run.decide(30);
    expect(await run.decide(40)).toEqual([]);
    const outside = await run.sleeve.decide(
      { tradingDate: '2030-01-01', macroDay: false, dryRun: true },
      [],
    );
    expect(outside).toEqual({ decisions: [], refusals: [] });
    expect(run.draws.redraws).toEqual([]);
    expect(run.draws.released).toEqual([]);
  });
});

describe('bookTrades', () => {
  const order = (id: string, book: string) =>
    `INSERT INTO v2_orders (client_order_id, book_id, trading_date, instrument, venue, leg, side,
       dry_run, outcome, payload, recorded_at)
     VALUES ('${id}', '${book}', '${DATES[0]}', 'A', 'saxo', 'entry', 'buy', 1, 'simulated', '{}', 't');`;
  const fill = (
    seq: number,
    book: string,
    at: number,
    instrument: string,
    side: string,
    qty: number,
  ) =>
    `INSERT INTO v2_fills (fill_seq, fill_id, client_order_id, book_id, trading_date, instrument,
       venue, leg, side, qty, price_gbp, fee_gbp, recorded_at, broker_mode)
     VALUES (${seq}, 'f-${seq}', 'o-${book}', '${book}', '${DATES[at]}', '${instrument}', 'saxo',
       '${side === 'buy' ? 'entry' : 'exit'}', '${side}', ${qty}, 100, 0, 't', 'paper');`;

  it('pairs each book’s fills into trades by session, partial closes included, and leaves an open one open', () => {
    const db = migratedMemoryStore();
    try {
      db.exec(
        [
          order('o-x/primary', 'x/primary'),
          order('o-y/primary', 'y/primary'),
          fill(1, 'x/primary', 2, 'A', 'buy', 10),
          fill(2, 'x/primary', 3, 'B', 'buy', 5),
          fill(3, 'x/primary', 4, 'A', 'sell', 4),
          fill(4, 'x/primary', 6, 'A', 'sell', 6),
          fill(5, 'y/primary', 1, 'A', 'sell', 3),
          fill(6, 'y/primary', 5, 'A', 'buy', 3),
        ].join('\n'),
      );
      expect(bookTrades(db, ['x/primary', 'y/primary', 'z/primary'], DATES)).toEqual([
        [
          { instrument: 'A', venue: 'saxo', side: 'buy', entry: 2, exit: 6 },
          { instrument: 'B', venue: 'saxo', side: 'buy', entry: 3, exit: undefined },
        ],
        [{ instrument: 'A', venue: 'saxo', side: 'sell', entry: 1, exit: 5 }],
        [],
      ]);
      expect(() => bookTrades(db, ['x/primary'], DATES.slice(3))).toThrow(
        `random canary: fill on ${DATES[2]} is not a session`,
      );
    } finally {
      db.close();
    }
  });
});

describe('fillLedger', () => {
  const order = (id: string, at: number, instrument: string, outcome: string, leg = 'entry') =>
    `INSERT INTO v2_orders (client_order_id, book_id, trading_date, instrument, venue, leg, side,
       dry_run, outcome, payload, recorded_at)
     VALUES ('${id}', 'r/primary', '${DATES[at]}', '${instrument}', 'saxo', '${leg}', 'buy', 1,
       '${outcome}', '{}', 't');`;
  const fill = (seq: number, id: string, book: string, at: number, side: string) =>
    `INSERT INTO v2_fills (fill_seq, fill_id, client_order_id, book_id, trading_date, instrument,
       venue, leg, side, qty, price_gbp, fee_gbp, recorded_at, broker_mode)
     VALUES (${seq}, 'f-${seq}', '${id}', '${book}', '${DATES[at]}', 'A', 'saxo',
       '${side === 'buy' ? 'entry' : 'stop'}', '${side}', 2, 100, 0, 't', 'paper');`;

  it('reads each entry as working, refused, open or closed from the journal and the fills', () => {
    const db = migratedMemoryStore();
    try {
      const ledger = fillLedger(DATES);
      const book = ledger.book('r/primary');
      expect(() => book.outcome('A', 10)).toThrow('random canary: the fill ledger has no store');
      ledger.attach(db);
      db.exec(
        [
          order('o-a', 10, 'A', 'simulated'),
          order('o-b', 10, 'B', 'cancelled'),
          order('o-c', 12, 'C', 'refused_dry_run'),
          order('o-x', 10, 'X', 'simulated', 'exit'),
        ].join('\n'),
      );
      expect(book.outcome('A', 10)).toEqual({ kind: 'working' });
      expect(book.outcome('B', 10)).toEqual({ kind: 'refused' });
      expect(book.outcome('C', 12)).toEqual({ kind: 'refused' });
      expect(book.outcome('X', 10)).toEqual({ kind: 'refused' });
      expect(book.outcome('D', 10)).toEqual({ kind: 'refused' });
      db.exec(fill(1, 'o-a', 'r/primary', 11, 'buy'));
      expect(book.outcome('A', 10)).toEqual({ kind: 'open' });
      expect(book.outcome('A', 12)).toEqual({ kind: 'refused' });
      db.exec(
        [fill(2, 'o-a', 'other/primary', 12, 'buy'), fill(3, 'o-a', 'r/primary', 14, 'sell')].join(
          '\n',
        ),
      );
      expect(book.outcome('A', 10)).toEqual({ kind: 'closed', held: 3 });
      expect(ledger.book('other/primary').outcome('A', 12)).toEqual({ kind: 'open' });
      expect(ledger.book('other/primary').outcome('A', 13)).toEqual({ kind: 'refused' });
      expect(book.outcome('A', 12)).toEqual({ kind: 'refused' });
      ledger.attach(migratedMemoryStore());
      expect(book.outcome('A', 10)).toEqual({ kind: 'refused' });
    } finally {
      db.close();
    }
  });
});
