import { describe, expect, it } from 'vitest';
import type {
  MarketData,
  SleeveDecision,
  SleeveSpec,
  SleeveValidation,
} from '../../../contracts/index.js';
import type { BarSeries, DailyBar, LogEntry } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import {
  type BacktestInput,
  type BacktestTrial,
  backtestSessions,
  entryOffsetIdentity,
  fencedMarket,
  runBacktest,
  type SleeveFactory,
  volTargetIdentity,
} from './backtest.js';
import { capitalCeilingGbp } from './backtest-verdict.js';
import { CanaryLog } from './canary-log.js';
import { addDays, BarsMarketData, parseBoeGbpUsdCsv } from './data/index.js';
import { delayedTrial } from './look-ahead-canary.js';
import { ENTRY_LIMIT_OFFSET } from './risk/index.js';
import { type SessionBLedger, TrialLedger, trialHash } from './trial-ledger.js';

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
  ['GONE', { symbol: 'GONE', bars: series('GONE', 0, 0).bars.slice(0, 71) }],
]);

const market = new BarsMarketData(
  { load: (symbol) => BARS.get(symbol) },
  parseBoeGbpUsdCsv('DATE,XUDLUSS\n29 Dec 2023,1.27\n'),
);

function spec(validation: SleeveValidation): SleeveSpec {
  return {
    capitalShare: 1,
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

function inertSleeve(id: string): SleeveFactory {
  return () => ({
    id,
    spec: spec('backtest'),
    universe: () => ({ instruments: [], refusals: [] }),
    decide: () => Promise.resolve({ decisions: [], refusals: [] }),
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

function yearLossesFor(
  dates: readonly string[],
  equity: readonly number[],
  startCapitalGbp = 1_000,
): Record<string, number> {
  const losses: Record<string, number> = {};
  let reference = startCapitalGbp;
  dates.forEach((date, index) => {
    if (dates[index + 1]?.slice(0, 4) === date.slice(0, 4)) return;
    losses[date.slice(0, 4)] = reference - (equity[index] as number);
    reference = equity[index] as number;
  });
  return losses;
}

function ledger(): TrialLedger {
  return new TrialLedger(
    migratedMemoryStore(),
    new SimulatedClock(new Date('2026-09-26T00:00:00.000Z')),
    SESSION_B,
  );
}

const FLAT_TRIAL: BacktestTrial = {
  config: { lookback: 20 },
  sleeve: trendSleeve('trend-20', 'FLAT', 20),
};

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
    expect(fenced.gbpUsdYearStartFixDate?.(2024)).toBe(market.gbpUsdYearStartFixDate(2024));
    expect(() => fenced.gbpUsdYearStartFixDate?.(2025)).toThrow(/lookahead/);
    expect(() => fenced.lastBarBefore('UP', DATES[31] as string)).toThrow(/lookahead/);
    expect(() => fenced.barsBefore('UP', DATES[31] as string, 1)).toThrow(/lookahead/);
    expect(() => fenced.gbpUsdAtYearStart(2025)).toThrow(
      `backtest: a sleeve read bars before 2025-01-01 on ${DATES[30]} (lookahead)`,
    );
  });
});

// CPU-heavy: cases ran up to ~32 s under coverage at load 25
describe('runBacktest', { timeout: 120_000 }, () => {
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

  it('runs the shift canary one bar later, logs it apart from the trials and leaves the count alone', async () => {
    const db = migratedMemoryStore();
    const shared = new TrialLedger(
      db,
      new SimulatedClock(new Date('2026-10-07T00:00:00Z')),
      SESSION_B,
    );
    const log = new CanaryLog(db, new SimulatedClock(new Date('2026-10-07T00:00:00Z')));
    const base = input({ ledger: shared });
    const run = { ...base, shiftCanary: { trials: base.trials.map(delayedTrial), log } };
    const result = await runBacktest(run);
    const plain = await runBacktest(input({ ledger: shared }));
    await runBacktest(run);
    expect(shared.count()).toBe(4);
    expect(result.verdict.trialsCounted).toBe(plain.verdict.trialsCounted);
    expect(result.verdict.deflatedSharpe).toBe(plain.verdict.deflatedSharpe);
    expect(result.trials).toEqual(plain.trials);
    const delay = result.verdict.oneBarDelay;
    expect(delay?.strategySharpe).not.toBe(result.verdict.walkForward.strategySharpe);
    expect(delay?.benchmarkSharpe).toBe(result.verdict.walkForward.benchmarkSharpe);
    expect(result.verdict.checks.survivesOneBarDelay).toBe(delay?.survives);
    expect(plain.verdict.oneBarDelay).toBeNull();
    expect(plain.verdict.pass).toBe(false);
    const configs = db
      .prepare("SELECT config FROM v2_trials WHERE source = 'v2' ORDER BY trial")
      .all() as { config: string }[];
    const candidateHash = trialHash('fixture-trend', {
      trials: configs.map(({ config }) => trialHash('fixture-trend', JSON.parse(config))),
    });
    const rows = log.list();
    expect(rows.map((row) => [row.candidate, row.candidate_hash, row.kind, row.seed])).toEqual([
      ['fixture-trend', candidateHash, 'shift', null],
      ['fixture-trend', candidateHash, 'shift', null],
    ]);
    expect(JSON.parse(rows[0]?.result as string)).toEqual(delay);
    expect(rows[0]?.recorded_at).toBe('2026-10-07T00:00:00.000Z');
  });

  it('refuses a shift canary that does not delay every trial', async () => {
    const db = migratedMemoryStore();
    const log = new CanaryLog(db, new SimulatedClock(new Date('2026-10-07T00:00:00Z')));
    const base = input();
    const run = { ...base, shiftCanary: { trials: [delayedTrial(FLAT_TRIAL)], log } };
    await expect(runBacktest(run)).rejects.toThrow(
      'backtest: the shift canary must delay every trial of the run',
    );
    expect(log.list()).toEqual([]);
    expect(base.ledger.count()).toBe(SESSION_B.entries.length);
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
    const run = input({ trials: [{ config: {}, sleeve: eager }, FLAT_TRIAL] });
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

  it('#1860: sizes only the sleeves the input vol target names, and records it in their identity', async () => {
    const db = migratedMemoryStore();
    const shared = new TrialLedger(
      db,
      new SimulatedClock(new Date('2026-10-07T00:00:00.000Z')),
      SESSION_B,
    );
    const unscaled = await runBacktest(input({ ledger: shared }));
    const volTarget = { annualTargetVol: 0.02, windowBars: 20, sleeveIds: ['trend-5'] };
    const scaled = await runBacktest(input({ ledger: shared, volTarget }));
    expect(scaled.trials.map((trial) => trial.trial)).toEqual([5, 6]);
    const swing = (equity: readonly number[] | undefined) =>
      Math.abs((equity?.at(-1) as number) - 1_000);
    expect(swing(scaled.trials[0]?.equity)).toBeGreaterThan(0);
    expect(swing(scaled.trials[0]?.equity)).toBeLessThan(swing(unscaled.trials[0]?.equity));
    expect(scaled.trials[1]?.equity).toEqual(unscaled.trials[1]?.equity);
    expect(scaled.benchmark).toEqual(unscaled.benchmark);
    const configs = db
      .prepare("SELECT config FROM v2_trials WHERE source = 'v2' ORDER BY trial")
      .all() as { config: string }[];
    expect(configs.map(({ config }) => JSON.parse(config).run.volTarget)).toEqual([
      undefined,
      undefined,
      volTarget,
      volTarget,
    ]);
  });

  it('#1860: marks the first instantiated book of a sleeve with no primary book', async () => {
    const technicalOnly: SleeveFactory = (m) => {
      const inner = trendSleeve('trend-5', 'UP', 5)(m);
      return {
        ...inner,
        spec: {
          ...inner.spec,
          books: [
            { variant: 'large-cap-only', instantiated: false },
            { variant: 'technical-only', instantiated: true },
          ],
        },
      };
    };
    const result = await runBacktest(
      input({ trials: [{ config: { lookback: 5 }, sleeve: technicalOnly }, FLAT_TRIAL] }),
    );
    const primary = await runBacktest(input());
    expect(result.trials[0]?.equity).toEqual(primary.trials[0]?.equity);
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
    expect(await numbers({ embargo: 2 })).toEqual([17, 18]);
    expect(await numbers({})).toEqual([3, 4]);
  });

  it('#1515: omits embargo from the run hash when unset, so an old candidate replays its own trial numbers unchanged', async () => {
    const shared = ledger();
    const baseline = await runBacktest(input({ ledger: shared }));
    const replay = await runBacktest(input({ ledger: shared, embargo: undefined }));
    expect(replay.trials.map((trial) => trial.trial)).toEqual(
      baseline.trials.map((trial) => trial.trial),
    );
    expect(shared.count()).toBe(SESSION_B.entries.length + 2);
  });

  it('#1815: records the entry offset in every trial identity', async () => {
    const db = migratedMemoryStore();
    const run = input({
      ledger: new TrialLedger(
        db,
        new SimulatedClock(new Date('2026-09-30T00:00:00.000Z')),
        SESSION_B,
      ),
    });
    await runBacktest(run);
    const configs = db
      .prepare("SELECT config FROM v2_trials WHERE source = 'v2' ORDER BY trial")
      .all() as { config: string }[];
    expect(configs).toHaveLength(2);
    for (const { config } of configs) {
      expect(JSON.parse(config).run.entryOffset).toEqual({
        reference: 'decision_close',
        capBps: 50,
      });
    }
  });

  it('fences each sleeve from bars after its session', async () => {
    const future = reading((m, date) => m.barsBefore('UP', addDays(date, 1), 1));
    await expect(
      runBacktest(input({ trials: [{ config: {}, sleeve: future }, FLAT_TRIAL] })),
    ).rejects.toThrow(
      `backtest: a sleeve read bars before ${addDays(DATES[40] as string, 1)} on ${DATES[40]} (lookahead)`,
    );
    const nextYear = reading((m, date) => m.gbpUsdAtYearStart(Number(date.slice(0, 4)) + 1));
    await expect(
      runBacktest(input({ trials: [{ config: {}, sleeve: nextYear }, FLAT_TRIAL] })),
    ).rejects.toThrow(/\(lookahead\)$/);
    const today = reading((m, date) => {
      m.lastBarBefore('UP', date);
      m.gbpUsdAtYearStart(Number(date.slice(0, 4)));
    });
    await expect(
      runBacktest(input({ trials: [{ config: {}, sleeve: today }, FLAT_TRIAL] })),
    ).resolves.toBeDefined();
  });

  it('runs trials whose shares sum above 1 side by side but refuses a share outside (0, 1]', async () => {
    const withShare =
      (share: number, id: string, instrument: string, lookback: number): SleeveFactory =>
      (m) => {
        const sleeve = trendSleeve(id, instrument, lookback)(m);
        return { ...sleeve, spec: { ...sleeve.spec, capitalShare: share } };
      };
    const trials = (share: number) => [
      { config: { lookback: 5 }, sleeve: withShare(share, 'trend-5', 'UP', 5) },
      { config: { lookback: 20 }, sleeve: withShare(share, 'trend-20', 'FLAT', 20) },
    ];
    const result = await runBacktest(input({ trials: trials(0.7) }));
    expect(result.trials).toHaveLength(2);
    await expect(runBacktest(input({ trials: trials(Number.NaN) }))).rejects.toThrow(
      "capital share: sleeve 'trend-5' declares NaN, outside (0, 1]",
    );
  });

  it("sets the capital ceiling from the trials' share of the loss cap and refuses mixed shares", async () => {
    const shared =
      (share: number, id: string, lookback: number): SleeveFactory =>
      (m) => {
        const sleeve = trendSleeve(id, 'UP', lookback)(m);
        return { ...sleeve, spec: { ...sleeve.spec, capitalShare: share } };
      };
    const grid = (first: number, second: number) => [
      { config: { lookback: 5 }, sleeve: shared(first, 'trend-5', 5) },
      { config: { lookback: 20 }, sleeve: shared(second, 'trend-20', 20) },
    ];
    const { verdict } = await runBacktest(input({ trials: grid(0.5, 0.5) }));
    expect(verdict.maxDrawdown).toBeGreaterThan(0);
    expect(verdict.capitalCeilingGbp).toBeCloseTo(
      capitalCeilingGbp(1_500 * 0.5, verdict.maxDrawdown),
      9,
    );
    const mixed = input({ trials: grid(0.5, 0.7) });
    await expect(runBacktest(mixed)).rejects.toThrow(
      'backtest: trials declare capital shares 0.5, 0.7; one grid takes one share',
    );
    expect(mixed.ledger.count()).toBe(2);
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

  it('runs the loss budget inside: a tight cap keeps each calendar year under it', async () => {
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
    const yearLosses = (result: Awaited<ReturnType<typeof run>>) =>
      yearLossesFor(result.dates, result.trials[0]?.equity as readonly number[]);
    const capped = await run(30);
    const uncapped = await run(100_000);
    expect(Object.keys(yearLosses(capped))).toEqual(['2024', '2025']);
    for (const loss of Object.values(yearLosses(capped))) expect(loss).toBeLessThan(30);
    expect(yearLosses(uncapped)['2024']).toBeGreaterThan(60);
    expect(capped.verdict.capitalCeilingGbp).toBeLessThan(uncapped.verdict.capitalCeilingGbp);
  });

  it("keeps a trial's equity independent of a sibling's losses and the benchmark's (per-sleeve budgets, #1941)", async () => {
    const tightCap = 30;
    const dumpAlongside = await runBacktest(
      input({
        lossCapGbp: tightCap,
        trials: [
          { config: { lookback: 0 }, sleeve: trendSleeve('dump', 'DOWN', 0) },
          { config: { lookback: 20 }, sleeve: trendSleeve('trend-20', 'FLAT', 20) },
        ],
        benchmark: { config: { lookback: 0 }, sleeve: trendSleeve('hold', 'DOWN', 0) },
      }),
    );
    const trendAlone = await runBacktest(
      input({
        lossCapGbp: tightCap,
        trials: [
          { config: { lookback: 20 }, sleeve: trendSleeve('trend-20', 'FLAT', 20) },
          { config: { inert: true }, sleeve: inertSleeve('inert') },
        ],
        benchmark: { config: { lookback: 0 }, sleeve: trendSleeve('hold', 'DOWN', 0) },
      }),
    );
    const dumpAlone = await runBacktest(
      input({
        lossCapGbp: tightCap,
        trials: [
          { config: { lookback: 0 }, sleeve: trendSleeve('dump', 'DOWN', 0) },
          { config: { inert: true }, sleeve: inertSleeve('inert') },
        ],
        benchmark: { config: { inert: true }, sleeve: inertSleeve('inert-benchmark') },
      }),
    );
    const dumpAloneYearLosses = yearLossesFor(
      dumpAlone.dates,
      dumpAlone.trials[0]?.equity as readonly number[],
    );
    expect(dumpAloneYearLosses['2024']).toBeGreaterThan(tightCap * 0.8);
    expect(dumpAloneYearLosses['2024']).toBeLessThan(tightCap);

    const trendAlongsideDump = dumpAlongside.trials[1]?.equity;
    expect(trendAlongsideDump).toEqual(trendAlone.trials[0]?.equity);
    expect(dumpAlongside.benchmark.equity).toEqual(trendAlone.benchmark.equity);
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
      runBacktest(input({ trials: [{ config: {}, sleeve: remapped(map) }, FLAT_TRIAL] }));
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

  it('#1785: a signal-driven exit rests, fills through the cycle, and stays flat', async () => {
    const exitFrom = DATES[80] as string;
    const flipExit: SleeveFactory = (m) => {
      const inner = trendSleeve('flip-exit', 'UP', 0)(m);
      return {
        ...inner,
        decide: async (context, instruments) => {
          const output = await inner.decide(context, instruments);
          if (context.tradingDate < exitFrom) return output;
          return {
            ...output,
            decisions: output.decisions.map((decision) => ({
              ...decision,
              action: 'exit' as const,
              reason: 'fixture exit',
            })),
          };
        },
      };
    };
    const result = await runBacktest(
      input({ trials: [{ config: { flip: true }, sleeve: flipExit }, FLAT_TRIAL] }),
    );
    const equity = result.trials[0]?.equity as readonly number[];
    const exitIndex = result.dates.indexOf(exitFrom);
    // Held and moving with UP's drift up to the exit signal; give the dry-run resting exit a
    // week of cycles to resolve into a fill, then flat (equity constant) for the rest of the run
    expect(new Set(equity.slice(1, exitIndex + 1)).size).toBeGreaterThan(1);
    const tail = equity.slice(exitIndex + 5);
    expect(new Set(tail).size).toBe(1);
  });

  it('#1911: closes a held name at its last close on the first session its bars are over 5 days stale, in the trial and the benchmark', async () => {
    const lastBarDate = DATES[70] as string;
    const holdGone =
      (id: string): SleeveFactory =>
      (m) => {
        const inner = trendSleeve(id, 'GONE', 0)(m);
        const base = spec('backtest');
        return {
          ...inner,
          spec: { ...base, sizing: { ...base.sizing, timeStopTradingDays: 1_000 } },
          decide: (context, instruments) =>
            context.tradingDate > (DATES[60] as string)
              ? Promise.resolve({ decisions: [], refusals: [] })
              : inner.decide(context, instruments),
        };
      };
    const logs: LogEntry[] = [];
    const result = await runBacktest(
      input({
        trials: [{ config: { gone: true }, sleeve: holdGone('gone') }, FLAT_TRIAL],
        benchmark: { config: { gone: true }, sleeve: holdGone('gone-benchmark') },
        logger: { log: (entry) => logs.push(entry) },
      }),
    );
    const exitDate = result.dates.find((date) => date > addDays(lastBarDate, 5)) as string;
    expect(
      logs
        .filter((entry) => entry.event === 'v2_series_ended_exit')
        .map((entry) => [entry.trace_id, entry.message]),
    ).toEqual(
      ['gone/primary', 'gone-benchmark/primary'].map((bookId) => [
        `v2-${exitDate}`,
        `${bookId} GONE: series ended ${lastBarDate}, closed at its last close (doc 70 §2.4)`,
      ]),
    );
    const staleMarks = logs.flatMap((entry) =>
      entry.event === 'v2_cycle_complete'
        ? (entry.payload as { refusals: string[] }).refusals.filter((r) => r.includes('marked at'))
        : [],
    );
    expect(staleMarks).toEqual([]);
    const exitIndex = result.dates.indexOf(exitDate) + 1;
    for (const equity of [result.trials[0]?.equity, result.benchmark.equity] as number[][]) {
      expect(equity[exitIndex]).toBeLessThan(equity[exitIndex - 1] as number);
      expect(new Set(equity.slice(exitIndex)).size).toBe(1);
    }
  });
});

describe('entryOffsetIdentity (#1815)', () => {
  const run = { from: '2024-01-01', to: '2024-12-31' };

  it('makes a changed offset a new trial', () => {
    const shared = ledger();
    const at = (capBps: number) =>
      shared.record('candidate', {
        lookback: 5,
        run: { ...run, ...entryOffsetIdentity({ reference: 'decision_close', capBps }) },
      });
    expect([at(0), at(50), at(100), at(50), at(0)]).toEqual([3, 4, 5, 4, 3]);
  });

  it('leaves a 0 bps run hashing as every trial recorded before the offset joined the identity', () => {
    const before = trialHash('candidate', { lookback: 5, run });
    const zero = { reference: 'decision_close', capBps: 0 } as const;
    expect(
      trialHash('candidate', { lookback: 5, run: { ...run, ...entryOffsetIdentity(zero) } }),
    ).toBe(before);
    expect(
      trialHash('candidate', {
        lookback: 5,
        run: { ...run, ...entryOffsetIdentity(ENTRY_LIMIT_OFFSET) },
      }),
    ).not.toBe(before);
  });
});

describe('volTargetIdentity (#1860)', () => {
  const run = { from: '2024-01-01', to: '2024-12-31' };
  const sizing = { annualTargetVol: 0.15, windowBars: 20, sleeveIds: ['arm2'] };

  it('leaves an unset vol target hashing as every trial recorded before #1860', () => {
    expect(volTargetIdentity(undefined)).toEqual({});
    expect(
      trialHash('candidate', { lookback: 5, run: { ...run, ...volTargetIdentity(undefined) } }),
    ).toBe(trialHash('candidate', { lookback: 5, run }));
  });

  it('makes each declared target, window and sleeve set a new trial', () => {
    const shared = ledger();
    const at = (volTarget: typeof sizing | undefined) =>
      shared.record('candidate', { lookback: 5, run: { ...run, ...volTargetIdentity(volTarget) } });
    expect([
      at(undefined),
      at(sizing),
      at({ ...sizing, annualTargetVol: 0.1 }),
      at({ ...sizing, windowBars: 60 }),
      at({ ...sizing, sleeveIds: ['debate'] }),
      at(sizing),
    ]).toEqual([3, 4, 5, 6, 7, 4]);
  });
});
