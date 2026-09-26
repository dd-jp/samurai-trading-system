import { describe, expect, it } from 'vitest';
import type {
  MarketData,
  SleeveDecision,
  SleeveSpec,
  SleeveValidation,
} from '../../../contracts/index.js';
import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import type { LogEntry } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import {
  type BacktestInput,
  backtestSessions,
  fencedMarket,
  runBacktest,
  type SleeveFactory,
} from './backtest.js';
import { addDays, BarsMarketData, parseBoeGbpUsdCsv } from './data/index.js';
import { type SessionBLedger, TrialLedger } from './trial-ledger.js';

const SESSION_B: SessionBLedger = {
  entries: [
    { trial: 1, config_hash: 'b1', config: { venue: 'lse' } },
    { trial: 2, config_hash: 'b2', config: { venue: 'us' } },
  ],
};

function weekdays(from: string, count: number): string[] {
  const dates: string[] = [];
  for (let ms = Date.parse(`${from}T00:00:00.000Z`); dates.length < count; ms += 86_400_000) {
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

const DATES = weekdays('2024-01-01', 330);

function series(symbol: string, drift: number, wobble: number): BarSeries {
  const bars: DailyBar[] = DATES.map((date, index) => {
    const close = 50 * (1 + drift) ** index * (1 + wobble * Math.sin(index / 3));
    return {
      date,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 2_000_000,
      rawClose: close,
    };
  });
  return { symbol, bars };
}

const BARS = new Map<string, BarSeries>([
  ['SPY', series('SPY', 0.0003, 0.002)],
  ['UP', series('UP', 0.001, 0.02)],
  ['FLAT', series('FLAT', 0, 0.03)],
  ['DOWN', series('DOWN', -0.004, 0.005)],
]);

const market = new BarsMarketData(
  { load: (symbol) => BARS.get(symbol) },
  parseBoeGbpUsdCsv('DATE,XUDLUSS\n29 Dec 2023,1.27\n'),
);

function spec(validation: SleeveValidation): SleeveSpec {
  return {
    minimumCapitalGbp: 0,
    capacityGbp: Number.POSITIVE_INFINITY,
    validation,
    macroGate: false,
    sizing: {
      riskFraction: 0.01,
      stopAtrMultiple: 2,
      targetAtrMultiple: 4,
      timeStopTradingDays: 5,
      advShare: 0.01,
      advWindowBars: 20,
    },
    books: [{ variant: 'primary', instantiated: true }],
  };
}

function trendSleeve(
  id: string,
  instrument: string,
  lookback: number,
  validation: SleeveValidation = 'backtest',
  veto?: string,
): SleeveFactory {
  return (market) => ({
    id,
    spec: spec(validation),
    universe: () => ({ instruments: [instrument], refusals: [] }),
    decide: (context) => {
      const bars = market.barsBefore(instrument, context.tradingDate, lookback + 1);
      const last = bars.at(-1);
      const first = bars[0];
      if (last === undefined || first === undefined || bars.length <= lookback) {
        return Promise.resolve({ decisions: [], refusals: [] });
      }
      const atr = last.close * 0.02;
      const decision: SleeveDecision = {
        sleeve_id: id,
        instrument,
        venue: 'alpaca',
        direction: 'bullish',
        confidence: 1,
        action: lookback === 0 || last.close > first.close ? 'enter_long' : 'none',
        reason: 'fixture trend',
        price: last.close,
        atr,
        stop_price: last.close - 2 * atr,
        inputs_hash: `${instrument}-${last.date}`,
        debate_id: undefined,
        veto,
        payload: {},
      };
      return Promise.resolve({ decisions: [decision], refusals: [] });
    },
  });
}

function reading(read: (market: MarketData, tradingDate: string) => void): SleeveFactory {
  return (market) => {
    const inner = trendSleeve('peek', 'UP', 5)(market);
    return {
      ...inner,
      decide: (context, instruments) => {
        read(market, context.tradingDate);
        return inner.decide(context, instruments);
      },
    };
  };
}

function ledger(): TrialLedger {
  return new TrialLedger(
    openSharedStore(':memory:'),
    new SimulatedClock(new Date('2026-09-26T00:00:00.000Z')),
    SESSION_B,
  );
}

function input(overrides: Partial<BacktestInput> = {}): BacktestInput {
  const logs: LogEntry[] = [];
  return {
    candidate: 'fixture-trend',
    trials: [
      { config: { lookback: 5 }, sleeve: trendSleeve('trend-5', 'UP', 5) },
      { config: { lookback: 20 }, sleeve: trendSleeve('trend-20', 'FLAT', 20) },
    ],
    benchmark: { config: { lookback: 1 }, sleeve: trendSleeve('hold', 'UP', 1) },
    from: DATES[40] as string,
    to: DATES[DATES.length - 1] as string,
    startCapitalGbp: 1_000,
    lossCapGbp: 1_500,
    market,
    halfSpreadBps: () => 5,
    ledger: ledger(),
    logger: { log: (entry) => logs.push(entry) },
    folds: 4,
    ...overrides,
  };
}

describe('backtestSessions', () => {
  it('lists the calendar reference sessions from the first date through the last', () => {
    expect(backtestSessions(market, DATES[10] as string, DATES[12] as string)).toEqual(
      DATES.slice(10, 13),
    );
  });

  it('refuses a window the calendar does not cover at either end or in the middle', () => {
    const first = DATES[0] as string;
    const last = DATES.at(-1) as string;
    expect(() => backtestSessions(market, addDays(first, -6), DATES[5] as string)).toThrow(
      `backtest: SPY has no session from ${addDays(first, -6)} to ${first}; the calendar does not cover ${addDays(first, -6)} to ${DATES[5]} (postmortem §2)`,
    );
    expect(backtestSessions(market, addDays(first, -5), DATES[5] as string)[0]).toBe(first);
    expect(() => backtestSessions(market, DATES[5] as string, addDays(last, 6))).toThrow(
      `backtest: SPY has no session from ${last} to ${addDays(last, 6)}`,
    );
    expect(backtestSessions(market, DATES[5] as string, addDays(last, 5)).at(-1)).toBe(last);
    const holed = new BarsMarketData(
      {
        load: (symbol) => {
          const full = BARS.get(symbol);
          return full && { ...full, bars: full.bars.filter((_, i) => i < 20 || i > 24) };
        },
      },
      parseBoeGbpUsdCsv('DATE,XUDLUSS\n29 Dec 2023,1.27\n'),
    );
    expect(() => backtestSessions(holed, DATES[10] as string, DATES[40] as string)).toThrow(
      `backtest: SPY has no session from ${DATES[19]} to ${DATES[25]}`,
    );
  });
});

describe('fencedMarket', () => {
  it('passes reads up to today through and refuses later ones', () => {
    const fenced = fencedMarket(market, () => DATES[30] as string);
    expect(fenced.barsBefore('UP', DATES[30] as string, 2)).toEqual(
      market.barsBefore('UP', DATES[30] as string, 2),
    );
    expect(fenced.lastBarBefore('UP', DATES[30] as string)?.date).toBe(DATES[29]);
    expect(fenced.gbpUsdAtYearStart(2024)).toBe(market.gbpUsdAtYearStart(2024));
    expect(() => fenced.lastBarBefore('UP', DATES[31] as string)).toThrow(/lookahead/);
    expect(() => fenced.barsBefore('UP', DATES[31] as string, 1)).toThrow(/lookahead/);
    expect(() => fenced.gbpUsdAtYearStart(2025)).toThrow(
      `backtest: a sleeve read bars before 2025-01-01 on ${DATES[30]} (lookahead)`,
    );
  });
});

describe('runBacktest', () => {
  it('runs every trial and the benchmark through the cycle and counts the trials after Session B', async () => {
    const run = input();
    const result = await runBacktest(run);
    expect(result.dates).toEqual(DATES.slice(40));
    expect(result.trials.map((trial) => [trial.trial, trial.sleeve])).toEqual([
      [3, 'trend-5'],
      [4, 'trend-20'],
    ]);
    for (const book of [...result.trials, result.benchmark]) {
      expect(book.equity).toHaveLength(result.dates.length + 1);
      expect(book.equity[0]).toBe(1_000);
      book.returns.forEach((value, index) => {
        expect(value).toBeCloseTo(
          (book.equity[index + 1] as number) / (book.equity[index] as number) - 1,
          12,
        );
      });
    }
    expect(result.trials[0]?.equity.at(-1)).not.toBe(1_000);
    expect(result.benchmark.equity.at(-1)).not.toBe(1_000);
    expect(
      new Set([...result.trials, result.benchmark].map((book) => book.equity.at(-1))).size,
    ).toBe(3);
    expect(result.verdict.trialsCounted).toBe(4);
    expect(result.verdict.from).toBe(DATES[40]);
    expect(run.ledger.count()).toBe(4);
  });

  it('has a capital row every year and a covered impact window on every fill', async () => {
    const logs: LogEntry[] = [];
    await runBacktest(input({ logger: { log: (entry) => logs.push(entry) } }));
    expect(logs.filter((entry) => entry.event === 'v2_impact_fallback')).toEqual([]);
    const cycles = logs.filter((entry) => entry.event === 'v2_cycle_complete');
    expect(cycles).toHaveLength(DATES.length - 40);
    const refusals = cycles.flatMap((entry) => (entry.payload as { refusals: string[] }).refusals);
    expect(refusals.filter((refusal) => refusal.includes('no capital config'))).toEqual([]);
  });

  it('fences a sleeve factory that reads ahead while it is built', async () => {
    const eager: SleeveFactory = (m) => {
      m.barsBefore('UP', DATES[45] as string, 1);
      return trendSleeve('trend-5', 'UP', 5)(m);
    };
    const run = input({ trials: [{ config: {}, sleeve: eager }, input().trials[1]!] });
    await expect(runBacktest(run)).rejects.toThrow(/\(lookahead\)$/);
    expect(run.ledger.count()).toBe(2);
  });

  it('is deterministic and records a repeated configuration once', async () => {
    const shared = ledger();
    const first = await runBacktest(input({ ledger: shared }));
    const second = await runBacktest(input({ ledger: shared }));
    expect(second.trials).toEqual(first.trials);
    expect(second.benchmark).toEqual(first.benchmark);
    expect(shared.count()).toBe(4);
  });

  it('counts a changed sizing as a new trial', async () => {
    const shared = ledger();
    await runBacktest(input({ ledger: shared }));
    const wider: SleeveFactory = (m) => {
      const resized = trendSleeve('trend-5', 'UP', 5)(m);
      return {
        ...resized,
        spec: { ...resized.spec, sizing: { ...resized.spec.sizing, stopAtrMultiple: 3 } },
      };
    };
    const result = await runBacktest(
      input({
        ledger: shared,
        trials: [
          { config: { lookback: 5 }, sleeve: wider },
          { config: { lookback: 20 }, sleeve: trendSleeve('trend-20', 'FLAT', 20) },
        ],
      }),
    );
    expect(result.trials.map((trial) => trial.trial)).toEqual([5, 4]);
  });

  it('counts a changed window, fold count, capital or benchmark as new trials', async () => {
    const shared = ledger();
    const from = DATES[200] as string;
    await runBacktest(input({ ledger: shared, from }));
    const numbers = async (overrides: Partial<BacktestInput>) =>
      (await runBacktest(input({ ledger: shared, from, ...overrides }))).trials.map((t) => t.trial);
    expect(await numbers({ from: DATES[201] as string })).toEqual([5, 6]);
    expect(await numbers({ to: DATES[DATES.length - 2] as string })).toEqual([7, 8]);
    expect(await numbers({ folds: 6 })).toEqual([9, 10]);
    expect(await numbers({ startCapitalGbp: 2_000 })).toEqual([11, 12]);
    expect(await numbers({ lossCapGbp: 1_000 })).toEqual([13, 14]);
    expect(
      await numbers({
        benchmark: { config: { lookback: 2 }, sleeve: trendSleeve('hold', 'UP', 2) },
      }),
    ).toEqual([15, 16]);
    expect(await numbers({})).toEqual([3, 4]);
  }, 20_000);

  it('fences each sleeve from bars after its session', async () => {
    const future = reading((m, date) => m.barsBefore('UP', addDays(date, 1), 1));
    await expect(
      runBacktest(input({ trials: [{ config: {}, sleeve: future }, input().trials[1]!] })),
    ).rejects.toThrow(
      `backtest: a sleeve read bars before ${addDays(DATES[40] as string, 1)} on ${DATES[40]} (lookahead)`,
    );
    const nextYear = reading((m, date) => m.gbpUsdAtYearStart(Number(date.slice(0, 4)) + 1));
    await expect(
      runBacktest(input({ trials: [{ config: {}, sleeve: nextYear }, input().trials[1]!] })),
    ).rejects.toThrow(/\(lookahead\)$/);
    const today = reading((m, date) => {
      m.lastBarBefore('UP', date);
      m.gbpUsdAtYearStart(Number(date.slice(0, 4)));
    });
    await expect(
      runBacktest(input({ trials: [{ config: {}, sleeve: today }, input().trials[1]!] })),
    ).resolves.toBeDefined();
  });

  it('refuses a forward-paper sleeve before recording any trial', async () => {
    const run = input({
      benchmark: { config: {}, sleeve: trendSleeve('debate', 'UP', 1, 'forward-paper') },
    });
    await expect(runBacktest(run)).rejects.toThrow(
      "backtest refuses sleeve 'debate': it is validated by forward paper only (doc 66 Q15, S7)",
    );
    expect(run.ledger.count()).toBe(2);
  });

  it('refuses a vetoed decision: only the rules are backtested', async () => {
    const run = input({
      trials: [
        { config: { lookback: 5 }, sleeve: trendSleeve('trend-5', 'UP', 5, 'backtest', 'llm') },
        { config: { lookback: 20 }, sleeve: trendSleeve('trend-20', 'FLAT', 20) },
      ],
    });
    await expect(runBacktest(run)).rejects.toThrow(
      "backtest refuses sleeve 'trend-5': a veto cannot be backtested, only its rules (doc 66 S7)",
    );
  });

  it('runs the loss budget inside: a tight cap halts entries and bounds the loss', async () => {
    const run = (lossCapGbp: number) =>
      runBacktest(
        input({
          lossCapGbp,
          trials: [
            { config: { lookback: 0 }, sleeve: trendSleeve('dump', 'DOWN', 0) },
            { config: { lookback: 20 }, sleeve: trendSleeve('trend-20', 'FLAT', 20) },
          ],
        }),
      );
    const capped = await run(30);
    const uncapped = await run(100_000);
    const lossOf = (result: Awaited<ReturnType<typeof run>>) =>
      1_000 - (result.trials[0]?.equity.at(-1) as number);
    expect(lossOf(uncapped)).toBeGreaterThan(60);
    expect(lossOf(capped)).toBeLessThan(lossOf(uncapped) / 2);
    expect(capped.verdict.capitalCeilingGbp).toBeLessThan(uncapped.verdict.capitalCeilingGbp);
  });

  it('checks the price of long and short entries only, and refuses a name with no bar', async () => {
    const remapped =
      (map: (decision: SleeveDecision) => SleeveDecision): SleeveFactory =>
      (m) => {
        const inner = trendSleeve('trend-0', 'UP', 0)(m);
        return {
          ...inner,
          decide: async (context, instruments) => {
            const output = await inner.decide(context, instruments);
            return { ...output, decisions: output.decisions.map(map) };
          },
        };
      };
    const run = (map: (decision: SleeveDecision) => SleeveDecision) =>
      runBacktest(input({ trials: [{ config: {}, sleeve: remapped(map) }, input().trials[1]!] }));
    await expect(run((decision) => ({ ...decision, price: decision.price * 0.9 }))).rejects.toThrow(
      /^backtest refuses sleeve 'trend-0': UP entry at /,
    );
    await expect(
      run((decision) => ({ ...decision, action: 'enter_short', price: decision.price * 0.9 })),
    ).rejects.toThrow(/^backtest refuses sleeve 'trend-0': UP entry at /);
    await expect(
      run((decision) => ({ ...decision, action: 'none', price: decision.price * 0.9 })),
    ).resolves.toBeDefined();
    await expect(run((decision) => ({ ...decision, instrument: 'NOPE' }))).rejects.toThrow(
      /^backtest refuses sleeve 'trend-0': NOPE entry at [\d.]+ is not the last raw close undefined;/,
    );
  });

  it('refuses an entry priced off the adjusted close', async () => {
    const mispriced: SleeveFactory = (m) => {
      const adjusted = trendSleeve('trend-5', 'UP', 5)(m);
      return {
        ...adjusted,
        decide: async (context, instruments) => {
          const output = await adjusted.decide(context, instruments);
          return {
            ...output,
            decisions: output.decisions.map((decision) => ({
              ...decision,
              price: decision.price * 0.9,
            })),
          };
        },
      };
    };
    const run = input({
      trials: [
        { config: { lookback: 5 }, sleeve: mispriced },
        { config: { lookback: 20 }, sleeve: trendSleeve('trend-20', 'FLAT', 20) },
      ],
    });
    await expect(runBacktest(run)).rejects.toThrow(
      /^backtest refuses sleeve 'trend-5': UP entry at [\d.]+ is not the last raw close [\d.]+; bars are dividend-adjusted, fills are at quoted prices$/,
    );
  });

  it('refuses a window with no sessions', async () => {
    await expect(runBacktest(input({ from: '2030-01-01', to: '2030-02-01' }))).rejects.toThrow(
      'backtest: no sessions from 2030-01-01 to 2030-02-01',
    );
  });
});
