import { describe, expect, it } from 'vitest';
import type { MarketData, SleeveDecision } from '../../../contracts/index.js';
import type { BarSeries, DailyBar } from '../../shared/index.js';
import { volTargetTrialArms } from './arm2-backtest.js';
import {
  ARM2_UK_POOL_FROM,
  ARM2_UK_POOL_TO,
  arm2UkPoolArms,
  arm2UkPoolVerdict,
  assertUkBarsReach,
  UK_POOL_ADV_SESSIONS,
  ukPoolCatalogue,
  ukStockPoolFromBars,
} from './arm2-uk-pool.js';
import type { BacktestTrial } from './backtest.js';
import {
  type BarsSource,
  CfdCatalogue,
  CfdCatalogueArchive,
  type CfdInstrument,
} from './data/index.js';
import { venueOf } from './index.js';
import {
  ARM2_ENTRY_THRESHOLDS,
  ARM2_UK_POOL_SLEEVE_ID,
  CFD_SHORT_MAX_BORROW_RATE_PER_YEAR,
  CFD_SLEEVE_IDS,
  LSE_RESERVED_SLOTS,
  requireSet,
  UK_STOCK_SCREENS,
  ukStockCfdRefusal,
} from './signal/index.js';

function weekdays(from: string, count: number): string[] {
  const dates: string[] = [];
  for (let ms = Date.parse(`${from}T00:00:00.000Z`); dates.length < count; ms += 86_400_000) {
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

const DATES = weekdays('2024-01-01', 261);
const TRADING_DATE = DATES.at(-1) as string;
const SCREENS = requireSet(UK_STOCK_SCREENS);

interface Shape {
  readonly close?: (index: number) => number;
  readonly volume?: (index: number) => number;
  readonly dates?: readonly string[];
}

function series(symbol: string, shape: Shape = {}): BarSeries {
  const close = shape.close ?? ((index: number) => 20 * 1.001 ** index);
  const volume = shape.volume ?? (() => 1_000_000);
  const bars: DailyBar[] = (shape.dates ?? DATES).map((date, index) => ({
    date,
    open: close(index),
    high: close(index) * 1.01,
    low: close(index) * 0.99,
    close: close(index),
    volume: volume(index),
    rawClose: close(index),
  }));
  return { symbol, bars };
}

function sourceOf(...all: readonly BarSeries[]): BarsSource {
  const bySymbol = new Map(all.map((one) => [one.symbol, one]));
  return { load: (symbol) => bySymbol.get(symbol) };
}

function row(symbol: string, over: Partial<CfdInstrument> = {}): CfdInstrument {
  const uk = symbol.endsWith('_XLON');
  return {
    symbol,
    saxoSymbol: symbol,
    uic: 1,
    assetType: 'CfdOnStock',
    currency: uk ? 'GBP' : 'USD',
    priceToContractFactor: uk ? 0.01 : 1,
    tradable: true,
    shortTradeDisabled: false,
    borrowCostPerDay: 0.005 / 365,
    ...over,
  };
}

function catalogueOf(asOf: string, rows: readonly CfdInstrument[]): CfdCatalogue {
  return new CfdCatalogue({ asOf, instruments: rows });
}

const ISF = series('ISF');
const SPY = series('SPY');

describe('ukStockPoolFromBars (#2143 (a), (d))', () => {
  it("pools today's tradable UK stock CFDs clearing £5m ADV and 100p, with no spread screen", () => {
    const bars = sourceOf(
      ISF,
      series('RR_XLON'),
      series('WIDE_XLON'),
      series('PENNY_XLON', { close: () => 0.99, volume: () => 100_000_000 }),
      series('THIN_XLON', { volume: () => 10_000 }),
      series('HALT_XLON'),
      series('ETF_XLON'),
      series('AAPL'),
    );
    const today = catalogueOf(TRADING_DATE, [
      row('RR_XLON'),
      row('WIDE_XLON', { bid: 5, ask: 6, averageVolume30Days: 1 }),
      row('PENNY_XLON'),
      row('THIN_XLON'),
      row('HALT_XLON', { tradable: false }),
      row('ETF_XLON', { assetType: 'CfdOnEtf' }),
      row('NOBARS_XLON'),
      row('AAPL'),
    ]);
    expect(ukStockPoolFromBars(bars, today, SCREENS)(TRADING_DATE)).toEqual([
      'RR_XLON',
      'WIDE_XLON',
    ]);
  });

  it('screens price at exactly 100p and ADV at exactly £5m as passing', () => {
    const bars = sourceOf(ISF, series('EDGE_XLON', { close: () => 1, volume: () => 5_000_000 }));
    const today = catalogueOf(TRADING_DATE, [row('EDGE_XLON')]);
    expect(ukStockPoolFromBars(bars, today, SCREENS)(TRADING_DATE)).toEqual(['EDGE_XLON']);
    const below = sourceOf(ISF, series('EDGE_XLON', { close: () => 1, volume: () => 4_999_999 }));
    expect(ukStockPoolFromBars(below, today, SCREENS)(TRADING_DATE)).toEqual([]);
  });

  it('takes a name in only once the 20 sessions before the date clear the screen', () => {
    const grows = series('GROW_XLON', { volume: (index) => (index < 200 ? 10_000 : 300_000) });
    const pool = ukStockPoolFromBars(
      sourceOf(ISF, grows),
      catalogueOf(TRADING_DATE, [row('GROW_XLON')]),
      SCREENS,
    );
    expect(pool(DATES[205] as string)).toEqual([]);
    expect(pool(DATES[200 + UK_POOL_ADV_SESSIONS] as string)).toEqual(['GROW_XLON']);
  });

  it('never reads the bar on or after the date it screens', () => {
    const spikeFrom = 230;
    const spikes = series('SPIKE_XLON', {
      volume: (index) => (index < spikeFrom ? 10_000 : 1_000_000_000),
    });
    const today = catalogueOf(TRADING_DATE, [row('SPIKE_XLON')]);
    const on = DATES[spikeFrom] as string;
    const full = ukStockPoolFromBars(sourceOf(ISF, spikes), today, SCREENS);
    const cut = { symbol: 'SPIKE_XLON', bars: spikes.bars.filter((bar) => bar.date < on) };
    const truncated = ukStockPoolFromBars(sourceOf(ISF, cut), today, SCREENS);
    expect(full(on)).toEqual([]);
    expect(full(on)).toEqual(truncated(on));
    expect(full(DATES[spikeFrom + 1] as string)).toEqual(['SPIKE_XLON']);
  });

  it('drops a name whose bars have gone stale or do not cover the window', () => {
    const stale = series('STALE_XLON', { dates: DATES.slice(0, -20) });
    const young = series('YOUNG_XLON', { dates: DATES.slice(-10) });
    const today = catalogueOf(TRADING_DATE, [row('STALE_XLON'), row('YOUNG_XLON')]);
    expect(ukStockPoolFromBars(sourceOf(ISF, stale, young), today, SCREENS)(TRADING_DATE)).toEqual(
      [],
    );
  });
});

describe('ukPoolCatalogue (#2143)', () => {
  it('returns the snapshot in force on the last day of the window', () => {
    const later = catalogueOf('2026-10-15', [row('RR_XLON')]);
    const archive = new CfdCatalogueArchive([catalogueOf('2026-10-13', [row('AAPL')]), later]);
    expect(ukPoolCatalogue(archive, '2026-10-16')).toBe(later);
  });

  it('refuses a window whose last snapshot holds no tradable UK stock CFD, or none at all', () => {
    const usOnly = new CfdCatalogueArchive([
      catalogueOf('2026-10-13', [row('AAPL'), row('RR_XLON', { tradable: false })]),
      catalogueOf('2026-10-15', [row('RR_XLON')]),
    ]);
    expect(() => ukPoolCatalogue(usOnly, '2026-10-14')).toThrow(/no archived CFD catalogue/);
    expect(() => ukPoolCatalogue(usOnly, '2026-10-12')).toThrow(/no archived CFD catalogue/);
  });
});

describe('assertUkBarsReach (#2143, postmortem §2)', () => {
  const today = catalogueOf(TRADING_DATE, [row('RR_XLON'), row('NEW_XLON'), row('AAPL')]);

  it('passes while one UK pool name still reaches the pinned start', () => {
    const bars = sourceOf(series('RR_XLON'), series('NEW_XLON', { dates: DATES.slice(100) }));
    expect(() => assertUkBarsReach(bars, today, DATES[0] as string)).not.toThrow();
  });

  it('fails once the rolling page has aged the pinned start out of every UK pool name', () => {
    const rolled = sourceOf(series('RR_XLON', { dates: DATES.slice(1) }), series('AAPL'));
    expect(() => assertUkBarsReach(rolled, today, DATES[0] as string)).toThrow(
      /aged out the trial's window/,
    );
    expect(() => assertUkBarsReach(sourceOf(), today, DATES[0] as string)).toThrow(/nowhere/);
  });

  it('pins the window measured on the bar store', () => {
    expect([ARM2_UK_POOL_FROM, ARM2_UK_POOL_TO]).toEqual(['2022-01-14', '2026-10-15']);
  });
});

const market = { gbpUsdAtYearStart: () => 1.25 } as unknown as MarketData;
const context = { tradingDate: TRADING_DATE, macroDay: false, dryRun: true };
const UK_NAMES = ['A_XLON', 'B_XLON', 'C_XLON', 'D_XLON', 'E_XLON', 'F_XLON', 'G_XLON'];
const US_NAMES = Array.from({ length: 12 }, (_, index) => `US${index}`);
const ARCHIVE = new CfdCatalogueArchive([catalogueOf('2026-10-13', [row('AAPL')])]);

function armsOver(bars: BarsSource, today: CfdCatalogue, constituents: readonly string[]) {
  return arm2UkPoolArms({
    bars,
    constituents: () => constituents,
    cfdCatalogues: ARCHIVE,
    today,
    screens: SCREENS,
  });
}

function saxoLiquidity(arm: BacktestTrial): number {
  const universe = arm.sleeve(market).universe(context).instruments;
  return universe.slice(0, 10).filter((symbol) => venueOf(symbol) === 'saxo').length;
}

describe('arm2UkPoolArms (#2143)', () => {
  const bars = sourceOf(
    ISF,
    SPY,
    ...UK_NAMES.map((symbol) => series(symbol)),
    ...US_NAMES.map((symbol) => series(symbol, { volume: () => 1_000_000_000 })),
  );
  const today = catalogueOf(
    TRADING_DATE,
    UK_NAMES.map((symbol) => row(symbol)),
  );
  const arms = armsOver(bars, today, US_NAMES);

  it('reserves 6 liquidity slots for the Saxo-homed names once the UK pool is in, 4 without', () => {
    expect(LSE_RESERVED_SLOTS).toBe(6);
    expect(saxoLiquidity(arms.trial)).toBe(LSE_RESERVED_SLOTS);
    expect(arms.ukStocks(TRADING_DATE)).toEqual(UK_NAMES);
    const etfOnly = sourceOf(
      SPY,
      ...['ISF', 'IUSA', 'IJPN', 'IEEM', 'IEUX', 'VMID'].map((tidm) => series(tidm)),
      ...US_NAMES.map((symbol) => series(symbol, { volume: () => 1_000_000_000 })),
    );
    expect(saxoLiquidity(armsOver(etfOnly, today, US_NAMES).baseline)).toBe(4);
    expect(saxoLiquidity(arms.baseline)).toBe(1);
  });

  it('identifies the trial by its pool rule, slots, route policy and unmodelled dividends', () => {
    expect(arms.trial.sleeve(market).id).toBe(ARM2_UK_POOL_SLEEVE_ID);
    expect(arms.baseline.sleeve(market).id).toBe('arm2');
    const catalogue = { asOf: today.asOf, sha256: today.sha256 };
    const routes = { catalogue, borrow_per_year: CFD_SHORT_MAX_BORROW_RATE_PER_YEAR };
    expect(arms.trial.config).toEqual({
      entries: 'arm2',
      arm2_entry_thresholds: ARM2_ENTRY_THRESHOLDS.value,
      universe: {
        reserved_lse_slots: 6,
        uk_stock_pool: {
          names: catalogue,
          adv_sessions: 20,
          min_adv_gbp: 5_000_000,
          min_price_pence: 100,
          spread_screen: false,
        },
      },
      cfd_routes_before_archive: routes,
      cfd_dividends: 'not_modelled',
    });
    expect(arms.baseline.config).toEqual({
      benchmark: 'arm2',
      universe: 'lse_etf_only',
      cfd_routes_before_archive: routes,
    });
    expect(CFD_SLEEVE_IDS).toContain(ARM2_UK_POOL_SLEEVE_ID);
  });

  describe('routes before the first snapshot', () => {
    const falling = (index: number) => 40 * 0.999 ** index;
    const routed = sourceOf(
      ISF,
      SPY,
      series('UP_XLON'),
      series('DOWN_XLON', { close: falling }),
      series('DOWN', { close: falling }),
    );
    const listed = catalogueOf(TRADING_DATE, [row('UP_XLON'), row('DOWN_XLON'), row('DOWN')]);
    const decide = async (arm: BacktestTrial, symbols: readonly string[]) => {
      const output = await arm.sleeve(market).decide(context, symbols);
      return output.decisions.map((decision: SleeveDecision) => ({
        instrument: decision.instrument,
        action: decision.action,
        venue: decision.venue,
        reason: decision.reason,
      }));
    };

    it("opens the UK switch and routes by today's list, for this trial alone", async () => {
      const uk = armsOver(routed, listed, ['DOWN']);
      expect(await decide(uk.trial, ['UP_XLON', 'DOWN_XLON', 'DOWN'])).toMatchObject([
        { instrument: 'UP_XLON', action: 'enter_long', venue: 'saxo_cfd_gbp' },
        { instrument: 'DOWN_XLON', action: 'enter_short', venue: 'saxo_cfd_gbp' },
        { instrument: 'DOWN', action: 'enter_short', venue: 'saxo_cfd_usd' },
      ]);
      expect(await decide(uk.baseline, ['DOWN'])).toMatchObject([
        { action: 'enter_short', venue: 'saxo_cfd_usd' },
      ]);
      const volTarget = volTargetTrialArms({
        bars: routed,
        constituents: () => ['DOWN'],
        cfdCatalogues: ARCHIVE,
      });
      for (const arm of [volTarget.trial, volTarget.baseline]) {
        expect(await decide(arm, ['UP_XLON', 'DOWN'])).toMatchObject([
          { action: 'skip', reason: 'long_unavailable:cfd_not_backtested' },
          { action: 'skip', reason: 'short_unavailable:cfd_not_backtested' },
        ]);
      }
      expect(ukStockCfdRefusal()).toBe('uk_stock_cfd_disabled');
    });
  });
});

describe('arm2UkPoolVerdict (#2143)', () => {
  const dates = ['2022-12-29', '2022-12-30', '2023-01-03', '2023-01-04'];
  const flat = { equity: [100, 100, 100, 100, 100], returns: [0, 0, 0, 0] };
  const rising = { equity: [100, 101, 102, 103, 104], returns: [0.01, 0.0099, 0.0098, 0.0098] };
  const input = {
    dates,
    trial: { ...rising, trial: 3, sleeve: ARM2_UK_POOL_SLEEVE_ID },
    baseline: flat,
    outOfSampleFrom: '2023-01-01',
    trialsCounted: 3,
    lossCapGbp: 450,
  };

  it('reports both arms on each side of the split, and no pass', () => {
    const verdict = arm2UkPoolVerdict(input);
    expect(verdict).toMatchObject({
      from: '2022-12-29',
      to: '2023-01-04',
      outOfSampleFrom: '2023-01-03',
      sessionsInSample: 2,
      sessionsOutOfSample: 2,
      trial: 3,
      trialsCounted: 3,
    });
    expect(verdict.ukPool.totalReturn).toBeCloseTo(0.04, 10);
    expect(verdict.etfOnly.totalReturn).toBe(0);
    expect(verdict).not.toHaveProperty('pass');
  });

  it('refuses series that do not cover the dates and a split leaving one side short', () => {
    expect(() => arm2UkPoolVerdict({ ...input, baseline: { equity: [100], returns: [] } })).toThrow(
      /same dates/,
    );
    expect(() => arm2UkPoolVerdict({ ...input, outOfSampleFrom: '2023-01-04' })).toThrow(
      /fewer than 2 sessions/,
    );
    expect(() => arm2UkPoolVerdict({ ...input, outOfSampleFrom: '2022-12-30' })).toThrow(
      /fewer than 2 sessions/,
    );
  });
});
