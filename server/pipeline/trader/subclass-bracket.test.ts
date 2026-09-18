import { describe, expect, it } from 'vitest';

import {
  AlwaysOpenCalendar,
  type Bar,
  type BarWindow,
  collectMarks,
  type IndicatorSpec,
  type IndicatorValue,
  type Mark,
  type MarketDataService,
  type MarkRead,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import type {
  Clock,
  InstrumentSubclass,
  OrderIntent,
  SetupNeighbor,
  SetupStore,
  SetupVector,
} from '../../shared/index.js';
import type { DebateResult } from '../debate-engine/index.js';
import { decide } from './decide.js';
import {
  ADR_0018_SUBCLASS_BRACKETS,
  D5_INDEX_ETP_DEPLOYMENT_FRACTION,
  D5_SCALE_IN_HEADROOM_RESERVE_FRACTION,
  D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
  resolveSubclassBracket,
  riskFractionFor,
  type SubclassBracket,
  SubclassBracketUnresolvableError,
} from './subclass-bracket.js';
import { DEFAULT_TRADER_CONFIG, type TraderConfig, type TraderInput } from './types.js';

const INDEX_ETP = '3USL';
const SINGLE_STOCK_ETP = '3LAP';
const DECISION_BAR = new Date('2026-07-15T10:00:00Z');
const ENTRY_PRICE = 40;
const EQUITY = 100_000;

const SUBCLASS_OF: Readonly<Record<string, InstrumentSubclass>> = {
  [INDEX_ETP]: 'index_etp_3x',
  [SINGLE_STOCK_ETP]: 'single_stock_etp_3x',
  'BTC-USD': 'crypto',
};

function bars(instrument: string, count: number, trueRange: number): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const close_time = new Date(DECISION_BAR.getTime() - (count - 1 - i) * 60 * 60 * 1000);
    return {
      instrument,
      timeframe: '1h',
      open_time: new Date(close_time.getTime() - 60 * 60 * 1000),
      close_time,
      open: ENTRY_PRICE,
      high: ENTRY_PRICE + trueRange / 2,
      low: ENTRY_PRICE - trueRange / 2,
      close: ENTRY_PRICE,
      volume: 1,
      source: 'fixture',
    };
  });
}

class FixtureMarketData implements MarketDataService {
  constructor(
    private readonly instrument: string,
    private readonly trueRange: number = 2,
  ) {}

  async getBars(_instrument: string, _window: BarWindow, _asOf: Date): Promise<Bar[]> {
    return bars(this.instrument, 15, this.trueRange);
  }

  async getMark(_instrument: string, _asOf: Date): Promise<Mark> {
    return {
      price: ENTRY_PRICE,
      observed_at: DECISION_BAR,
      source: 'fixture',
      asset_class: 'stocks',
    };
  }

  async getMarks(instruments: readonly string[], asOf: Date): Promise<Map<string, MarkRead>> {
    return collectMarks((instrument, at) => this.getMark(instrument, at), instruments, asOf);
  }

  async getIndicator(
    _instrument: string,
    _spec: IndicatorSpec,
    _asOf: Date,
  ): Promise<IndicatorValue> {
    throw new Error('FixtureMarketData.getIndicator: not part of the entry path');
  }

  async getSpreadEstimate(): Promise<number | null> {
    throw new Error('FixtureMarketData.getSpreadEstimate: not part of the Trader path');
  }

  async getQuote(): Promise<null> {
    throw new Error('FixtureMarketData.getQuote: not part of the Trader path');
  }

  async getADV(): Promise<number> {
    throw new Error('FixtureMarketData.getADV: not part of the Trader path');
  }
}

class SelfPrecedentStore implements SetupStore {
  findNeighbors(vector: SetupVector, asOf: Date): SetupNeighbor[] {
    return [{ vector, r_multiple: 0, closed_at: new Date(asOf.getTime() - 60_000) }];
  }

  writeSetup(): void {}

  labelSetup(): void {}
}

function debateResult(overrides: Partial<DebateResult> = {}): DebateResult {
  return {
    synthesis: 'Analysts converge on upside momentum.',
    position: 'Enter long.',
    confidence: 1,
    contributions: [],
    disagreement_summary: '',
    open_items: [],
    converged: true,
    rounds_completed: 2,
    latency_ms: 9_000,
    direction: 'bullish',
    debate_id: 'debate-subclass',
    bar_timestamp: DECISION_BAR,
    read: true,
    ...overrides,
  };
}

const CLOCK: Clock = { now: () => DECISION_BAR };

function traderInput(instrument: string, overrides: Partial<TraderInput> = {}): TraderInput {
  return {
    trace_id: 'trace-739',
    instrument,
    debate: debateResult(),
    clock: CLOCK,
    marketData: new FixtureMarketData(instrument),
    equity: async () => EQUITY,
    config: armedConfig(),
    positionState: async () => [],
    exitFillSizes: async () => new Map<string, number>(),
    unresolvedFlattens: async () => [],
    setupStore: new SelfPrecedentStore(),
    sessionCalendars: {
      crypto: new AlwaysOpenCalendar(),
      stocks: new UsEquityRegularHoursCalendar(),
    },
    ...overrides,
  };
}

function armedConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return { ...DEFAULT_TRADER_CONFIG, subclass_of: SUBCLASS_OF, ...overrides };
}

async function entryFor(instrument: string, overrides: Partial<TraderInput> = {}) {
  const intent: OrderIntent | null = await decide(traderInput(instrument, overrides));
  if (intent === null) throw new Error(`expected an entry intent for ${instrument}, got null`);
  return intent;
}

const firstTrancheFraction = (deployment: number): number =>
  deployment * (1 - D5_SCALE_IN_HEADROOM_RESERVE_FRACTION);

describe("the frozen bracket sizes to ADR-0018 D5's deployment", () => {
  it('commits 31.5% of equity to a 3x index ETP — 35% less #897 headroom', async () => {
    const intent = await entryFor(INDEX_ETP);

    expect(intent.size * intent.entry).toBeCloseTo(
      firstTrancheFraction(D5_INDEX_ETP_DEPLOYMENT_FRACTION) * EQUITY,
      6,
    );
    expect(intent.size * intent.entry).toBeLessThan(D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY);
  });

  it('commits 22.5% of equity to a 3x single-stock ETP — 25% less #897 headroom', async () => {
    const intent = await entryFor(SINGLE_STOCK_ETP);

    expect(intent.size * intent.entry).toBeCloseTo(
      firstTrancheFraction(D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION) * EQUITY,
      6,
    );
    expect(intent.size * intent.entry).toBeLessThan(
      D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * EQUITY,
    );
  });

  it('deploys the two subclasses DIFFERENTLY under one asset_class', async () => {
    const index = await entryFor(INDEX_ETP);
    const singleStock = await entryFor(SINGLE_STOCK_ETP);

    expect(singleStock.size * singleStock.entry).toBeLessThan(index.size * index.entry);
  });

  it('scales the deployment with equity rather than with the mark', async () => {
    const half = await entryFor(INDEX_ETP, { equity: async () => EQUITY / 2 });

    expect(half.size * half.entry).toBeCloseTo(
      (firstTrancheFraction(D5_INDEX_ETP_DEPLOYMENT_FRACTION) * EQUITY) / 2,
      6,
    );
  });
});

describe("the bracket geometry is ADR-0018 D3's frozen percentages", () => {
  it('stops a 3x index ETP at -2.16% and targets +2.00%', async () => {
    const intent = await entryFor(INDEX_ETP);

    expect(intent.stop).toBeCloseTo(ENTRY_PRICE * (1 - 0.0216), 9);
    expect(intent.target).toBeCloseTo(ENTRY_PRICE * (1 + 0.02), 9);
  });

  it('stops a 3x single-stock ETP at -6.25% and targets +6.00%', async () => {
    const intent = await entryFor(SINGLE_STOCK_ETP);

    expect(intent.stop).toBeCloseTo(ENTRY_PRICE * (1 - 0.0625), 9);
    expect(intent.target).toBeCloseTo(ENTRY_PRICE * (1 + 0.06), 9);
  });

  it('mirrors the bracket onto a short without changing its width', async () => {
    const intent = await entryFor(INDEX_ETP, { debate: debateResult({ direction: 'bearish' }) });

    expect(intent.side).toBe('sell');
    expect(intent.stop).toBeCloseTo(ENTRY_PRICE * (1 + 0.0216), 9);
    expect(intent.target).toBeCloseTo(ENTRY_PRICE * (1 - 0.02), 9);
  });

  it('does not move the stop, the target or the size when ATR changes', async () => {
    const calm = await entryFor(INDEX_ETP, { marketData: new FixtureMarketData(INDEX_ETP, 0.5) });
    const wild = await entryFor(INDEX_ETP, { marketData: new FixtureMarketData(INDEX_ETP, 5) });

    expect(wild.stop).toBeCloseTo(calm.stop, 9);
    expect(wild.target).toBeCloseTo(calm.target, 9);
    expect(wild.size).toBeCloseTo(calm.size, 9);
  });

  it('is flat across the entry window — the same bracket at every decision time', async () => {
    const late = new Date('2026-07-15T19:00:00Z');
    const intent = await entryFor(INDEX_ETP, {
      clock: { now: () => late },
      debate: debateResult({ bar_timestamp: late }),
    });

    expect(intent.stop).toBeCloseTo(ENTRY_PRICE * (1 - 0.0216), 9);
    expect(intent.target).toBeCloseTo(ENTRY_PRICE * (1 + 0.02), 9);
  });
});

describe('the ATR read survives the frozen stop', () => {
  it('still embeds an ATR in the setup vector precedent retrieves on', async () => {
    let retrievedOn: SetupVector | null = null;
    const store: SetupStore = {
      findNeighbors(vector, asOf) {
        retrievedOn = vector;
        return [{ vector, r_multiple: 0, closed_at: new Date(asOf.getTime() - 60_000) }];
      },
      writeSetup() {},
      labelSetup() {},
    };

    await entryFor(INDEX_ETP, { setupStore: store });

    const vector = retrievedOn as SetupVector | null;
    expect(vector).not.toBeNull();
    for (const feature of vector?.market_features ?? []) {
      expect(Number.isFinite(feature)).toBe(true);
    }
    expect((vector?.market_features ?? []).length).toBeGreaterThan(0);
  });
});

describe('an unresolvable subclass fails loud', () => {
  it('throws for an instrument the armed map does not classify', async () => {
    await expect(entryFor('SPY')).rejects.toBeInstanceOf(SubclassBracketUnresolvableError);
  });

  it('throws for a subclass ADR-0018 declares no bracket for', async () => {
    await expect(entryFor('BTC-USD')).rejects.toBeInstanceOf(SubclassBracketUnresolvableError);
  });

  it('never falls back to a default bracket, which would be full deployment', () => {
    expect(() => resolveSubclassBracket('SPY', SUBCLASS_OF, ADR_0018_SUBCLASS_BRACKETS)).toThrow(
      /has no subclass/,
    );
  });

  it('leaves the pre-ADR-0018 geometry alone when NO instrument is classified', async () => {
    const intent = await entryFor(INDEX_ETP, { config: armedConfig({ subclass_of: {} }) });

    expect(intent.stop).not.toBeCloseTo(ENTRY_PRICE * (1 - 0.0216), 9);
    expect(intent.metadata.sizing.frozen_bracket).toBeUndefined();
  });
});

describe('an out-of-range headroom reserve fails loud, not silently (#897)', () => {
  const withReserve = (reserve: number): TraderConfig =>
    armedConfig({
      subclass_brackets: {
        ...ADR_0018_SUBCLASS_BRACKETS,
        index_etp_3x: {
          ...(ADR_0018_SUBCLASS_BRACKETS.index_etp_3x as SubclassBracket),
          headroom_reserve_fraction: reserve,
        },
      },
    });

  const resolveWith = (reserve: number): SubclassBracket | null =>
    resolveSubclassBracket(INDEX_ETP, SUBCLASS_OF, withReserve(reserve).subclass_brackets);

  it('throws on a PERCENT written where a fraction belongs — 10, not 0.10', () => {
    expect(() => resolveWith(10)).toThrow(SubclassBracketUnresolvableError);
    expect(() => resolveWith(10)).toThrow(/headroom_reserve_fraction = 10/);
    expect(() => resolveWith(10)).toThrow(/index_etp_3x/);
    expect(() => resolveWith(10)).toThrow(new RegExp(INDEX_ETP));
  });

  it('throws on 1 — reserving the WHOLE envelope sizes every entry to zero', () => {
    expect(() => resolveWith(1)).toThrow(SubclassBracketUnresolvableError);
  });

  it('throws on a negative reserve', () => {
    expect(() => resolveWith(-0.1)).toThrow(SubclassBracketUnresolvableError);
  });

  it('ACCEPTS 0 — the pre-#897 behaviour, and how an amendment turns the reserve off', () => {
    const bracket = resolveWith(0);

    expect(bracket).not.toBeNull();
    expect(riskFractionFor(bracket as SubclassBracket)).toBeCloseTo(
      D5_INDEX_ETP_DEPLOYMENT_FRACTION * 0.0216,
      9,
    );
  });

  it('validates in the RESOLVER, which is the only production path to riskFractionFor', () => {
    const unvalidated = withReserve(10).subclass_brackets.index_etp_3x as SubclassBracket;

    expect(riskFractionFor(unvalidated)).toBeLessThan(0);
  });
});

describe('the round trip is injected config, never a constant', () => {
  it('records the quote the decision was made under', async () => {
    const moved: SubclassBracket = {
      ...(ADR_0018_SUBCLASS_BRACKETS.index_etp_3x as SubclassBracket),
      round_trip_cost_pct: 0.0031,
    };
    const intent = await entryFor(INDEX_ETP, {
      config: armedConfig({
        subclass_brackets: { ...ADR_0018_SUBCLASS_BRACKETS, index_etp_3x: moved },
      }),
    });

    expect(intent.metadata.sizing.frozen_bracket?.round_trip_cost_pct).toBe(0.0031);
  });

  it('does not let the round trip touch the size or the geometry', async () => {
    const moved: SubclassBracket = {
      ...(ADR_0018_SUBCLASS_BRACKETS.index_etp_3x as SubclassBracket),
      round_trip_cost_pct: 0.05,
    };
    const asDeclared = await entryFor(INDEX_ETP);
    const withMovedCost = await entryFor(INDEX_ETP, {
      config: armedConfig({
        subclass_brackets: { ...ADR_0018_SUBCLASS_BRACKETS, index_etp_3x: moved },
      }),
    });

    expect(withMovedCost.size).toBeCloseTo(asDeclared.size, 9);
    expect(withMovedCost.stop).toBeCloseTo(asDeclared.stop, 9);
  });
});

describe("riskFractionFor reproduces ADR-0018's conversion table, net of #897", () => {
  it('converts each deployment through its OWN subclass stop, less the headroom reserve', () => {
    expect(riskFractionFor(ADR_0018_SUBCLASS_BRACKETS.index_etp_3x as SubclassBracket)).toBeCloseTo(
      0.00756 * (1 - D5_SCALE_IN_HEADROOM_RESERVE_FRACTION),
      9,
    );
    expect(
      riskFractionFor(ADR_0018_SUBCLASS_BRACKETS.single_stock_etp_3x as SubclassBracket),
    ).toBeCloseTo(0.015625 * (1 - D5_SCALE_IN_HEADROOM_RESERVE_FRACTION), 9);
  });

  it('reserves headroom on BOTH rows — a zero reserve is the state #897 was filed over', () => {
    for (const subclass of ['index_etp_3x', 'single_stock_etp_3x'] as const) {
      const bracket = ADR_0018_SUBCLASS_BRACKETS[subclass] as SubclassBracket;
      expect(bracket.headroom_reserve_fraction).toBeGreaterThan(0);
      expect(bracket.headroom_reserve_fraction).toBeLessThan(1);
      expect(riskFractionFor(bracket)).toBeLessThan(bracket.deployment_fraction * bracket.stop_pct);
    }
  });

  it('reads the reserve off the INJECTED bracket rather than a module constant', () => {
    const doubled: SubclassBracket = {
      ...(ADR_0018_SUBCLASS_BRACKETS.index_etp_3x as SubclassBracket),
      headroom_reserve_fraction: 0.2,
    };

    expect(riskFractionFor(doubled)).toBeCloseTo(0.35 * 0.0216 * 0.8, 9);
  });
});

describe('the reserved headroom is a real tranche, not a rounding artefact (#897)', () => {
  it('reserves 3.5% / 2.5% of equity, clearing the £10 dust floor at the £1,000 book', () => {
    const book = 1_000;
    const index = ADR_0018_SUBCLASS_BRACKETS.index_etp_3x as SubclassBracket;
    const singleStock = ADR_0018_SUBCLASS_BRACKETS.single_stock_etp_3x as SubclassBracket;

    const indexHeadroom = index.deployment_fraction * index.headroom_reserve_fraction * book;
    const singleStockHeadroom =
      singleStock.deployment_fraction * singleStock.headroom_reserve_fraction * book;

    expect(indexHeadroom).toBeCloseTo(35, 9);
    expect(singleStockHeadroom).toBeCloseTo(25, 9);
    expect(indexHeadroom).toBeGreaterThan(DEFAULT_TRADER_CONFIG.min_viable_notional);
    expect(singleStockHeadroom).toBeGreaterThan(DEFAULT_TRADER_CONFIG.min_viable_notional);
  });

  it('records the equities below which the reserved slice stops clearing that floor', () => {
    const floor = DEFAULT_TRADER_CONFIG.min_viable_notional;
    const boundary = (bracket: SubclassBracket): number =>
      floor / (bracket.deployment_fraction * bracket.headroom_reserve_fraction);

    const indexBoundary = boundary(ADR_0018_SUBCLASS_BRACKETS.index_etp_3x as SubclassBracket);
    const singleStockBoundary = boundary(
      ADR_0018_SUBCLASS_BRACKETS.single_stock_etp_3x as SubclassBracket,
    );

    expect(indexBoundary).toBeCloseTo(285.714, 3);
    expect(singleStockBoundary).toBeCloseTo(400, 9);
    expect(singleStockBoundary).toBeGreaterThan(indexBoundary);
  });
});
