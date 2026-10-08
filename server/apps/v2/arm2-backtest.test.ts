import { describe, expect, it } from 'vitest';
import type { MarketData, Sleeve } from '../../../contracts/index.js';
import type { BarSeries, DailyBar } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import {
  ARM2_BACKTEST_SPEC,
  arm2BacktestSleeve,
  VOL_TARGET_TRIAL_SIZING,
  VOL_TARGET_TRIAL_SLEEVE_ID,
  volTargetTrialArms,
} from './arm2-backtest.js';
import { addDays } from './data/index.js';
import { ARM2_ENTRY_THRESHOLDS, ARM2_SLEEVE_SPEC, createArm2Sleeve } from './signal/index.js';

function trending(symbol: string, days: number): BarSeries {
  const bars: DailyBar[] = [];
  const origin = Date.UTC(2024, 0, 1);
  for (let i = 0; i < days; i += 1) {
    const close = 100 * (1 + 0.001 * i);
    bars.push({
      date: new Date(origin + i * 86_400_000).toISOString().slice(0, 10),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
      rawClose: close,
    });
  }
  return { symbol, bars };
}

const UP = trending('UP', 260);
const SPY = trending('SPY', 260);
const bars = { load: (symbol: string) => [UP, SPY].find((series) => series.symbol === symbol) };
const market = { gbpUsdAtYearStart: () => 1.25 } as unknown as MarketData;
const tradingDate = addDays(UP.bars.at(-1)?.date ?? '', 1);

describe('arm2BacktestSleeve (#1860)', () => {
  it("decides arm 2's entries under its own id with arm 2's spec, validated by backtest", async () => {
    const sleeve = arm2BacktestSleeve({ bars, constituents: () => ['UP'] }, 'arm2-copy')(market);
    expect(sleeve.id).toBe('arm2-copy');
    expect(sleeve.spec).toEqual({ ...ARM2_SLEEVE_SPEC, validation: 'backtest' });
    const context = { tradingDate, macroDay: false, dryRun: true };
    const universe = sleeve.universe(context);
    expect(universe.instruments).toEqual(['UP']);
    const output = await sleeve.decide(context, universe.instruments);
    expect(output.decisions).toHaveLength(1);
    expect(output.decisions[0]).toMatchObject({
      sleeve_id: 'arm2-copy',
      instrument: 'UP',
      venue: 'alpaca',
      action: 'enter_long',
      price: UP.bars.at(-1)?.rawClose,
    });
  });

  it('hashes the same inputs as arm 2 itself', async () => {
    const context = { tradingDate, macroDay: false, dryRun: true };
    const copy = arm2BacktestSleeve({ bars, constituents: () => ['UP'] }, 'arm2-copy')(market);
    const live = createArm2Sleeve({
      bars,
      constituents: () => ['UP'],
      venueFor: () => 'alpaca',
      market,
      clock: new SimulatedClock(new Date(`${tradingDate}T07:00:00.000Z`)),
    });
    const hash = async (sleeve: Sleeve) =>
      (await sleeve.decide(context, ['UP'])).decisions[0]?.inputs_hash;
    expect(await hash(copy)).toHaveLength(64);
    expect(await hash(copy)).toBe(await hash(live));
  });

  it('keeps arm 2 itself forward-paper only', () => {
    expect(ARM2_SLEEVE_SPEC.validation).toBe('forward-paper');
    expect(ARM2_BACKTEST_SPEC.validation).toBe('backtest');
  });
});

describe('volTargetTrialArms (#1860)', () => {
  it('scales only the trial copy, at 25% a year over 20 days, and identifies it by arm 2 entries', () => {
    const arms = volTargetTrialArms({ bars, constituents: () => ['UP'] });
    expect(VOL_TARGET_TRIAL_SIZING).toEqual({
      annualTargetVol: 0.25,
      windowBars: 20,
      sleeveIds: [VOL_TARGET_TRIAL_SLEEVE_ID],
    });
    expect(arms.trial.sleeve(market).id).toBe(VOL_TARGET_TRIAL_SLEEVE_ID);
    expect(arms.baseline.sleeve(market).id).toBe('arm2');
    expect(arms.trial.config).toEqual({
      entries: 'arm2',
      arm2_entry_thresholds: ARM2_ENTRY_THRESHOLDS.value,
    });
    expect(arms.baseline.config).toEqual({ benchmark: 'arm2' });
  });
});
