import { describe, expect, it } from 'vitest';
import type { SleeveSpec } from '../../../contracts/index.js';
import type { BarSeries, DailyBar } from '../../shared/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { BarsMarketData, parseBoeGbpUsdCsv } from './data/index.js';
import type { WalkForwardPath } from './evidence/index.js';
import {
  bookTrades,
  entryRead,
  type MatchedTrade,
  matchedSessions,
  matchedTrades,
  RANDOM_CANARY_FIRST_SEED,
  RANDOM_CANARY_RUNS,
  RANDOM_ENTRY_ATR_WINDOW,
  randomEntrySleeve,
  randomScheduler,
  type ScheduledTrade,
  type ScheduleInput,
  seededRandom,
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
    venue: 'saxo',
    side: 'buy',
    hold: 5,
    ...overrides,
  };
}

function schedule(trades: readonly MatchedTrade[], universe = ['A', 'B', 'LATE']): ScheduleInput {
  return { matched: trades, dates: DATES, market, universe: () => universe };
}

describe('constants', () => {
  it('declares 200 seeded runs from seed 1 and a 20-bar entry ATR', () => {
    expect(RANDOM_CANARY_RUNS).toBe(200);
    expect(RANDOM_CANARY_FIRST_SEED).toBe(1);
    expect(RANDOM_ENTRY_ATR_WINDOW).toBe(20);
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
      { trial: 1, range: path.testRanges[0], venue: 'alpaca', side: 'buy', hold: 4 },
      { trial: 0, range: path.testRanges[1], venue: 'saxo', side: 'sell', hold: 4 },
      { trial: 0, range: path.testRanges[1], venue: 'saxo', side: 'buy', hold: undefined },
    ]);
    expect(matchedSessions(rows)).toBe(8);
    expect(sessionsHeld(trades[0] ?? [])).toBe(6);
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
    const rows = randomScheduler(schedule(trades))(3);
    expect(rows).toHaveLength(trades.length);
    rows.forEach((row, index) => {
      const trade = trades[index] as MatchedTrade;
      expect(row.side).toBe(trade.side);
      expect(row.venue).toBe(trade.venue);
      expect(row.exit).toBe(row.entry + (trade.hold as number));
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
    expect(scheduler(1)).toEqual(scheduler(1));
    expect(scheduler(1)).not.toEqual(scheduler(2));
  });

  it('holds an open trade, or one whose exit falls past the window, to the end and drops a trade with no free slot', () => {
    const late = { fold: 3, start: 75, end: 76 };
    const trades = [
      matched({ range: late, hold: undefined }),
      matched({ range: late, hold: 30 }),
      matched({ range: late, hold: 1 }),
    ];
    const rows = randomScheduler(schedule(trades, ['A', 'B']))(5);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.exit)).toEqual([undefined, undefined]);
    expect(new Set(rows.map((row) => row.instrument))).toEqual(new Set(['A', 'B']));
  });

  it('draws from the universe of the trial that made the trade', () => {
    const seen: [number, string][] = [];
    const input: ScheduleInput = {
      matched: [matched({ trial: 1 })],
      dates: DATES,
      market,
      universe: (trial, date) => {
        seen.push([trial, date]);
        return trial === 1 ? ['B'] : ['A'];
      },
    };
    expect(randomScheduler(input)(9).map((row) => row.instrument)).toEqual(['B']);
    expect(new Set(seen.map(([trial]) => trial))).toEqual(new Set([1]));
  });
});

describe('randomEntrySleeve', () => {
  const rows: ScheduledTrade[] = [
    { instrument: 'A', venue: 'saxo', side: 'buy', entry: 30, exit: 33 },
    { instrument: 'B', venue: 'alpaca', side: 'sell', entry: 33, exit: undefined },
  ];
  const sleeve = randomEntrySleeve(
    { id: 'c-random-1', spec: SPEC, schedule: rows, dates: DATES },
    market,
  );
  const decide = (at: number) =>
    sleeve.decide({ tradingDate: DATES[at] as string, macroDay: false, dryRun: true }, []);

  it('carries its spec and lists the names it schedules', () => {
    expect(sleeve.id).toBe('c-random-1');
    expect(sleeve.spec).toBe(SPEC);
    expect(
      sleeve.universe({ tradingDate: DATES[0] as string, macroDay: false, dryRun: true }),
    ).toEqual({
      instruments: ['A', 'B'],
      refusals: [],
    });
  });

  it('enters at the quoted close with the spec stop and exits when the hold has run', async () => {
    const entry = await decide(30);
    const read = entryRead(market, 'A', DATES[30] as string);
    expect(entry.decisions).toEqual([
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
    const swap = await decide(33);
    const short = entryRead(market, 'B', DATES[33] as string);
    expect(swap.decisions.map((row) => [row.instrument, row.action])).toEqual([
      ['A', 'exit'],
      ['B', 'enter_short'],
    ]);
    expect(swap.decisions[1]?.direction).toBe('bearish');
    expect(swap.decisions[1]?.stop_price).toBe(
      (short?.price as number) + 3 * (short?.atr as number),
    );
    expect((await decide(31)).decisions).toEqual([]);
    expect(
      (await sleeve.decide({ tradingDate: '2030-01-01', macroDay: false, dryRun: true }, []))
        .decisions,
    ).toEqual([]);
  });

  it('skips an entry it cannot quote', async () => {
    const early = randomEntrySleeve(
      {
        id: 'c-random-2',
        spec: SPEC,
        schedule: [{ instrument: 'LATE', venue: 'saxo', side: 'buy', entry: 30, exit: 31 }],
        dates: DATES,
      },
      market,
    );
    const output = await early.decide(
      { tradingDate: DATES[30] as string, macroDay: false, dryRun: true },
      [],
    );
    expect(output).toEqual({ decisions: [], refusals: [] });
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
