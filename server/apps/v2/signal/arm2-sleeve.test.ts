import { describe, expect, it } from 'vitest';
import type { Sleeve, SleeveContext, SleeveOutput } from '../../../../contracts/index.js';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import type { BarsSource, CfdInstrument } from '../data/index.js';
import { addDays, CfdCatalogue, createVenueRouter } from '../data/index.js';
import { createArm2Sleeve } from './arm2-sleeve.js';
import { technicalRead } from './debate-sleeve.js';
import { ARM2_ENTRY_THRESHOLDS, ARM2_SLEEVE_SPEC, requireSet } from './parameters.js';

const clock = new SimulatedClock(new Date('2026-09-25T07:00:00.000Z'));
const market = { gbpUsdAtYearStart: () => 1.25 };

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
  it('enters long on a bullish technical read with a 2-ATR stop', async () => {
    const series = trending('UP', 260, 0.001);
    const sleeve = createArm2Sleeve({
      bars: source([series]),
      constituents: () => ['UP', 'MISSING'],
      venueFor: () => 'alpaca',
      market,
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

  it('skips a bearish read while the CFD short route is closed, and does nothing on a genuinely flat read', async () => {
    const down = trending('DOWN', 260, -0.001);
    const flat = trending('FLAT', 260, 0);
    const sleeve = createArm2Sleeve({
      bars: source([down, flat]),
      constituents: () => ['DOWN', 'FLAT'],
      venueFor: () => 'alpaca',
      market,
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
      reason: 'short_unavailable:cfd_cost_model_unset',
      venue: 'alpaca',
    });
    const neutral = output.decisions.find((decision) => decision.instrument === 'FLAT');
    expect(neutral).toMatchObject({
      direction: 'neutral',
      confidence: 0.5,
      action: 'none',
      reason: 'technical neutral',
    });
  });

  it('routes a bearish read to the CFD venue once the router is open, and a bullish one stays home', async () => {
    const down = trending('DOWN', 260, -0.001);
    const up = trending('UP', 260, 0.001);
    const tradingDate = nextDate(down);
    const instrument = (symbol: string): CfdInstrument => ({
      symbol,
      saxoSymbol: symbol,
      uic: 1,
      assetType: 'CfdOnStock',
      currency: 'USD',
      priceToContractFactor: 1,
      tradable: true,
      shortTradeDisabled: false,
      borrowCostPerDay: 0.0000137,
    });
    const router = createVenueRouter({
      catalogue: new CfdCatalogue({
        asOf: tradingDate,
        instruments: [instrument('DOWN'), instrument('UP')],
      }),
      costModelSet: true,
      maxBorrowRatePerYear: 0.02,
    });
    const sleeve = createArm2Sleeve({
      bars: source([down, up]),
      constituents: () => ['DOWN', 'UP'],
      venueFor: () => 'alpaca',
      router,
      market,
      clock,
    });
    const output = await decideAll(sleeve, { tradingDate, macroDay: false, dryRun: true });
    expect(output.decisions.find((d) => d.instrument === 'DOWN')).toMatchObject({
      action: 'enter_short',
      venue: 'saxo_cfd_usd',
    });
    expect(output.decisions.find((d) => d.instrument === 'UP')).toMatchObject({
      action: 'enter_long',
      venue: 'alpaca',
    });
  });

  it('hashes only the last 200 bars of history, tagged apart from the debate sleeve (#1773)', async () => {
    const base = trending('UP', 260, 0.001);
    const decide = async (series: BarSeries) => {
      const sleeve = createArm2Sleeve({
        bars: source([series]),
        constituents: () => ['UP'],
        venueFor: () => 'alpaca',
        market,
        clock,
      });
      const output = await decideAll(sleeve, {
        tradingDate: nextDate(series),
        macroDay: false,
        dryRun: true,
      });
      return output.decisions[0]?.inputs_hash;
    };
    const retouch = (index: number): BarSeries => ({
      symbol: base.symbol,
      bars: base.bars.map((bar, i) => (i === index ? { ...bar, open: bar.open * 1.5 } : bar)),
    });
    const reference = await decide(base);
    expect(await decide(retouch(59))).toBe(reference);
    expect(await decide(retouch(60))).not.toBe(reference);
  });

  it('skips a name whose 200-session window is not covered, before any decision', async () => {
    const series = trending('UP', 260, 0.001);
    const full = { symbol: 'FULL', bars: series.bars };
    const gapped = { symbol: 'GAPPED', bars: series.bars.filter((_, index) => index % 15 !== 0) };
    const sleeve = createArm2Sleeve({
      bars: source([full, gapped]),
      constituents: () => ['GAPPED'],
      venueFor: () => 'alpaca',
      market,
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

  it("reproduces the debate sleeve's own zero-threshold technical read exactly (#1773 parity)", async () => {
    expect(requireSet(ARM2_ENTRY_THRESHOLDS)).toEqual({ longAbove: 0, shortBelow: 0 });
    const cases: ReadonlyArray<readonly [string, BarSeries]> = [
      ['UP', trending('UP', 260, 0.001)],
      ['DOWN', trending('DOWN', 260, -0.001)],
      ['FLAT', trending('FLAT', 260, 0)],
    ];
    for (const [symbol, series] of cases) {
      const sleeve = createArm2Sleeve({
        bars: source([series]),
        constituents: () => [symbol],
        venueFor: () => 'alpaca',
        market,
        clock,
      });
      const output = await decideAll(sleeve, {
        tradingDate: nextDate(series),
        macroDay: false,
        dryRun: true,
      });
      const expected = technicalRead(series.bars, 't', clock.now());
      expect(output.decisions[0]?.direction).toBe(expected?.view.direction);
    }
  });

  it('uses the same universe as the debate sleeve, and its own sleeve id', async () => {
    const series = trending('UP', 260, 0.001);
    const sleeve = createArm2Sleeve({
      bars: source([series]),
      constituents: () => ['UP'],
      venueFor: () => 'alpaca',
      market,
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
