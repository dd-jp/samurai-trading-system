import { describe, expect, it } from 'vitest';
import type { Sleeve, SleeveContext, SleeveOutput } from '../../../../contracts/index.js';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import type { BarsSource } from '../data/index.js';
import { addDays } from '../data/index.js';
import { createArm2Sleeve } from './arm2-sleeve.js';
import { resolveTechnical, technicalRead } from './debate-sleeve.js';
import { ARM2_ENTRY_THRESHOLDS, ARM2_SLEEVE_SPEC, requireSet } from './parameters.js';

const clock = new SimulatedClock(new Date('2026-09-25T07:00:00.000Z'));

function trending(symbol: string, days: number, slope: number, start = 100): BarSeries {
  const bars: DailyBar[] = [];
  const origin = Date.UTC(2025, 0, 1);
  for (let i = 0; i < days; i += 1) {
    const close = start * (1 + slope * i);
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

function withCalendar(all: readonly BarSeries[]): readonly BarSeries[] {
  const dates = [...new Set(all.flatMap((entry) => entry.bars.map((bar) => bar.date)))].sort();
  const reference = dates.map((date) => ({
    date,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    rawClose: 1,
  }));
  return [...all, { symbol: 'SPY', bars: reference }];
}

function source(all: readonly BarSeries[]): BarsSource {
  const withReference = withCalendar(all);
  return { load: (symbol) => withReference.find((entry) => entry.symbol === symbol) };
}

const nextDate = (series: BarSeries) => addDays(series.bars.at(-1)?.date ?? '', 1);

async function decideAll(sleeve: Sleeve, context: SleeveContext): Promise<SleeveOutput> {
  const universe = sleeve.universe(context);
  const output = await sleeve.decide(context, universe.instruments);
  return { decisions: output.decisions, refusals: [...universe.refusals, ...output.refusals] };
}

describe('createArm2Sleeve', () => {
  it('enters long on a bullish technical read with a 2-ATR stop, and makes no LLM call', async () => {
    const series = trending('UP', 260, 0.001);
    const sleeve = createArm2Sleeve({
      bars: source([series]),
      constituents: () => ['UP', 'MISSING'],
      venueFor: () => 'alpaca',
      clock,
    });
    const output = await decideAll(sleeve, {
      tradingDate: nextDate(series),
      macroDay: false,
      dryRun: true,
    });
    expect(output.decisions).toHaveLength(1);
    const decision = output.decisions[0];
    expect(decision).toMatchObject({
      sleeve_id: 'arm2',
      instrument: 'UP',
      venue: 'alpaca',
      direction: 'bullish',
      confidence: 0.6,
      action: 'enter_long',
      reason: 'technical bullish',
      debate_id: undefined,
    });
    expect(decision?.stop_price).toBeCloseTo(
      (decision?.price ?? 0) - ARM2_SLEEVE_SPEC.sizing.stopAtrMultiple * (decision?.atr ?? 0),
      9,
    );
    expect(decision?.inputs_hash).toHaveLength(64);
  });

  it('skips a bearish read because shorts are off, and does nothing on a genuinely flat read', async () => {
    const down = trending('DOWN', 260, -0.001);
    const flat = trending('FLAT', 260, 0);
    const sleeve = createArm2Sleeve({
      bars: source([down, flat]),
      constituents: () => ['DOWN', 'FLAT'],
      venueFor: () => 'alpaca',
      clock,
    });
    const output = await decideAll(sleeve, {
      tradingDate: nextDate(down),
      macroDay: false,
      dryRun: true,
    });
    const short = output.decisions.find((decision) => decision.instrument === 'DOWN');
    expect(short).toMatchObject({
      direction: 'bearish',
      action: 'skip',
      reason: 'shorts_disabled',
    });
    const neutral = output.decisions.find((decision) => decision.instrument === 'FLAT');
    expect(neutral).toMatchObject({
      direction: 'neutral',
      action: 'none',
      reason: 'technical neutral',
    });
  });

  it('skips a name whose 200-session window is not covered, before any decision', async () => {
    const series = trending('UP', 260, 0.001);
    const full = { symbol: 'FULL', bars: series.bars };
    const gapped = { symbol: 'GAPPED', bars: series.bars.filter((_, index) => index % 15 !== 0) };
    const sleeve = createArm2Sleeve({
      bars: source([full, gapped]),
      constituents: () => ['GAPPED'],
      venueFor: () => 'alpaca',
      clock,
    });
    const output = await decideAll(sleeve, {
      tradingDate: nextDate(series),
      macroDay: false,
      dryRun: true,
    });
    expect(output.decisions.find((d) => d.instrument === 'GAPPED')).toMatchObject({
      sleeve_id: 'arm2',
      action: 'skip',
      reason: 'window_coverage',
    });
  });

  it('resolveTechnical reports no_bars for a symbol with no series, tagged with the caller sleeve elsewhere', () => {
    const outcome = resolveTechnical(
      source([]),
      () => 'alpaca',
      'NOBARS',
      '2026-01-01',
      clock.now(),
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'no_bars' });
  });

  it("reproduces the debate sleeve's own zero-threshold technical read exactly (#1773 parity)", () => {
    const bullish = technicalRead(trending('UP', 260, 0.001).bars, 't', clock.now());
    const bearish = technicalRead(trending('DOWN', 260, -0.001).bars, 't', clock.now());
    const flat = technicalRead(trending('FLAT', 30, 0.001).bars, 't', clock.now());
    expect(requireSet(ARM2_ENTRY_THRESHOLDS)).toEqual({ longAbove: 0, shortBelow: 0 });
    expect(bullish?.view.direction).toBe('bullish');
    expect(bearish?.view.direction).toBe('bearish');
    expect(flat?.view.direction).toBe('neutral');
  });

  it('uses the same universe as the debate sleeve, and its own sleeve id', async () => {
    const series = trending('UP', 260, 0.001);
    const sleeve = createArm2Sleeve({
      bars: source([series]),
      constituents: () => ['UP'],
      venueFor: () => 'alpaca',
      clock,
    });
    const universe = sleeve.universe({
      tradingDate: nextDate(series),
      macroDay: false,
      dryRun: true,
    });
    expect(universe.instruments).toContain('UP');
    expect(sleeve.id).toBe('arm2');
    expect(sleeve.spec).toBe(ARM2_SLEEVE_SPEC);
  });
});
