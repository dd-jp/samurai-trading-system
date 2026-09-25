import { describe, expect, it } from 'vitest';
import type {
  Sleeve,
  SleeveDecision,
  SleeveSpec,
  SleeveValidation,
} from '../../../contracts/index.js';
import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import type { LogEntry } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { type BacktestInput, backtestSessions, runBacktest } from './backtest.js';
import { BarsMarketData, parseBoeGbpUsdCsv } from './data/index.js';
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
): Sleeve {
  return {
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
    benchmark: trendSleeve('hold', 'UP', 1),
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
    expect(result.verdict.trialsCounted).toBe(4);
    expect(result.verdict.from).toBe(DATES[40]);
    expect(run.ledger.count()).toBe(4);
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
    const resized = trendSleeve('trend-5', 'UP', 5);
    const wider = {
      ...resized,
      spec: { ...resized.spec, sizing: { ...resized.spec.sizing, stopAtrMultiple: 3 } },
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

  it('refuses a forward-paper sleeve before recording any trial', async () => {
    const run = input({ benchmark: trendSleeve('debate', 'UP', 1, 'forward-paper') });
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

  it('refuses an entry priced off the adjusted close', async () => {
    const adjusted = trendSleeve('trend-5', 'UP', 5);
    const run = input({
      trials: [
        {
          config: { lookback: 5 },
          sleeve: {
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
          },
        },
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
