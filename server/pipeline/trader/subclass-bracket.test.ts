/**
 * ADR-0018 D3/D5 through the Trader (#739) — the frozen per-subclass bracket
 * and the deployment it sizes to.
 *
 * **Every sizing assertion here is on the resulting DEPLOYMENT**
 * (`size x entry ~= fraction x equity`), never on a config value. ADR-0018's
 * sizing amendment records that both of its silent error modes produce a
 * `risk_fraction` that matches a number printed in the ADR — storing `0.35`
 * (16.2x equity) and pairing the single-stock deployment with the index stop
 * (`0.00540`, which deploys 8.6% instead of 25%, errs small and trips no gate)
 * — so a constant-equality test is exactly the test that ships both.
 *
 * The one thing the deployment assertion CANNOT see is a wrong `stop_pct`: it
 * cancels out of `size x entry = equity x (deployment x stop_pct) / stop_pct`.
 * That number is the live stop, so it is asserted separately on the emitted
 * bracket's geometry, and the two assertions together cover the pair.
 */
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

/** Flat closes, so ATR is exactly `trueRange` and any ATR leak is visible */
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

/**
 * A store that returns the target setup itself as its own neighbor, with
 * `r_multiple: 0`.
 *
 * Cosine similarity is then 1.0 and `rToMultiplier(0)` is exactly 1.0x, so the
 * cosine stage neither raises nor lowers the size. That matters here more than
 * anywhere else in the suite: the default `FixtureSetupStore` is empty, which
 * takes the 0.75x no-precedent haircut, and a deployment test run through a
 * 0.75x would have to divide the haircut back out — i.e. assert the formula it
 * is meant to be checking.
 */
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
    // Full conviction: `convictionMultiplier` is 1.0 at 1.0, so the deployment
    // asserted below is D5's envelope itself rather than a scaled slice of it
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

/**
 * The FIRST tranche's share of the envelope, per #897: the deployment fraction
 * net of the headroom reserve. Written as the product of the two named
 * constants rather than as a literal `0.315`, so an ADR amendment that moves
 * either one moves these assertions with it.
 */
const firstTrancheFraction = (deployment: number): number =>
  deployment * (1 - D5_SCALE_IN_HEADROOM_RESERVE_FRACTION);

describe("the frozen bracket sizes to ADR-0018 D5's deployment", () => {
  it('commits 31.5% of equity to a 3x index ETP — 35% less #897 headroom', async () => {
    // Still the DEPLOYMENT assertion, not a constant-equality one: both of
    // ADR-0018's recorded error modes (a stored `0.35`; the single-stock
    // deployment paired with the index stop) fail this line, because neither
    // lands on `deployment x (1 - reserve) x equity`. #897 moved the target,
    // not the kind of assertion
    const intent = await entryFor(INDEX_ETP);

    expect(intent.size * intent.entry).toBeCloseTo(
      firstTrancheFraction(D5_INDEX_ETP_DEPLOYMENT_FRACTION) * EQUITY,
      6,
    );
    // And it lands strictly under the envelope the Risk Manager's D5 cap
    // enforces — the property that makes a scale-in admissible at all (#897)
    expect(intent.size * intent.entry).toBeLessThan(D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY);
  });

  it('commits 22.5% of equity to a 3x single-stock ETP — 25% less #897 headroom', async () => {
    // The discriminator. Pairing this row with the INDEX stop gives
    // `risk_fraction = 0.25 x 0.0216 = 0.00540`, which deploys 8.64% here —
    // a number that matches nothing and breaches nothing, which is why the
    // assertion is on the deployment rather than on the constant
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
    // Both instruments are `asset_class: 'stocks'`, so an
    // `asset_class_risk_multiplier` keying cannot express this split at all —
    // it would size both identically while looking implemented
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
    // The withdrawal of the ATR-floating geometry, asserted rather than
    // assumed: a 10x wider true range moved every one of these numbers before
    // this ticket
    const calm = await entryFor(INDEX_ETP, { marketData: new FixtureMarketData(INDEX_ETP, 0.5) });
    const wild = await entryFor(INDEX_ETP, { marketData: new FixtureMarketData(INDEX_ETP, 5) });

    expect(wild.stop).toBeCloseTo(calm.stop, 9);
    expect(wild.target).toBeCloseTo(calm.target, 9);
    expect(wild.size).toBeCloseTo(calm.size, 9);
  });

  it('is flat across the entry window — the same bracket at every decision time', async () => {
    // #708 rejected the entry-time-conditional bracket schedule (<= 0.56 pp
    // against a ~4 pp bar, sign-flipping cell to cell), so a bracket that
    // varied with `t0` would be implementing a measurement that was refused
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
    // ATR no longer sets the stop, but it still feeds the setup vector, the
    // Feedback Loop's realized-R labelling and the volatility halt. Deleting
    // the ATR computation alongside the config keys is how that halt loses its
    // input while the diff reads as a cleanup
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
    // Every market feature must be a real number: an undefined ATR poisons the
    // vector rather than throwing, which is silent everywhere downstream
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
    // `crypto: null` is an answer — "not set by this ADR" — so there is no
    // measured geometry to enter on. Sizing it on the index row's numbers is
    // the failure the throw exists to prevent
    await expect(entryFor('BTC-USD')).rejects.toBeInstanceOf(SubclassBracketUnresolvableError);
  });

  it('never falls back to a default bracket, which would be full deployment', () => {
    expect(() => resolveSubclassBracket('SPY', SUBCLASS_OF, ADR_0018_SUBCLASS_BRACKETS)).toThrow(
      /has no subclass/,
    );
  });

  it('leaves the pre-ADR-0018 geometry alone when NO instrument is classified', async () => {
    // The arming rule, identical to the Risk Manager's D5 gate: an empty map is
    // a universe that declares no subclasses (DEFAULT_UNIVERSE, the smoke
    // universe, every backtest fixture), not a pool file to throw over
    const intent = await entryFor(INDEX_ETP, { config: armedConfig({ subclass_of: {} }) });

    expect(intent.stop).not.toBeCloseTo(ENTRY_PRICE * (1 - 0.0216), 9);
    expect(intent.metadata.sizing.frozen_bracket).toBeUndefined();
  });
});

describe('an out-of-range headroom reserve fails loud, not silently (#897)', () => {
  // The failure being guarded is quiet: a percent-vs-fraction typo makes
  // `riskFractionFor` negative, `size` negative-but-finite, and `decide.ts`'s
  // `min_viable_notional` check then turns EVERY entry in the subclass into
  // `skip('below_min_notional')` — indistinguishable in a soak log from a
  // market that offered no setups. These tests pin the throw that replaces it.
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
    // The message has to carry all three, or the operator cannot act on it
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
    // And it is a real zero, not a coerced one: sizing collapses back to the
    // full envelope exactly as it did before #897
    expect(riskFractionFor(bracket as SubclassBracket)).toBeCloseTo(
      D5_INDEX_ETP_DEPLOYMENT_FRACTION * 0.0216,
      9,
    );
  });

  it('validates in the RESOLVER, which is the only production path to riskFractionFor', () => {
    // `decide.ts` reaches `riskFractionFor` (line ~581) only through
    // `resolveSubclassBracket` (line ~556), so the resolver covers every real
    // sizing call while keeping the per-decision hot function pure. Both are
    // exported from the module, so a FUTURE caller could still hold a bracket
    // that never passed the resolver — this test states the assumption so it
    // fails visibly if that stops being true
    const unvalidated = withReserve(10).subclass_brackets.index_etp_3x as SubclassBracket;

    expect(riskFractionFor(unvalidated)).toBeLessThan(0);
  });
});

describe('the round trip is injected config, never a constant', () => {
  it('records the quote the decision was made under', async () => {
    // 0.18% / 0.41% is still a single unmeasured quote (ADR-0016 Known
    // weakness; delivery owned by #1053), and the accuracy bar moves directly
    // with these figures — a constant compiled into a later analysis would
    // silently price a decision against a spread it was never taken at
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
    // Recorded because the ADR records it — but note this is the WEAK
    // assertion: `0.00540` also appears in the ADR (as the error). The tests
    // above are the ones that discriminate
    //
    // 0.35 x 0.0216 x 0.9 = 0.006804; 0.25 x 0.0625 x 0.9 = 0.0140625
    expect(riskFractionFor(ADR_0018_SUBCLASS_BRACKETS.index_etp_3x as SubclassBracket)).toBeCloseTo(
      0.00756 * (1 - D5_SCALE_IN_HEADROOM_RESERVE_FRACTION),
      9,
    );
    expect(
      riskFractionFor(ADR_0018_SUBCLASS_BRACKETS.single_stock_etp_3x as SubclassBracket),
    ).toBeCloseTo(0.015625 * (1 - D5_SCALE_IN_HEADROOM_RESERVE_FRACTION), 9);
  });

  it('reserves headroom on BOTH rows — a zero reserve is the state #897 was filed over', () => {
    // The reserve is per-subclass config precisely so the two rows CAN differ;
    // this asserts only that neither ships at zero, which is the pre-#897
    // behaviour
    for (const subclass of ['index_etp_3x', 'single_stock_etp_3x'] as const) {
      const bracket = ADR_0018_SUBCLASS_BRACKETS[subclass] as SubclassBracket;
      expect(bracket.headroom_reserve_fraction).toBeGreaterThan(0);
      expect(bracket.headroom_reserve_fraction).toBeLessThan(1);
      expect(riskFractionFor(bracket)).toBeLessThan(bracket.deployment_fraction * bracket.stop_pct);
    }
  });

  it('reads the reserve off the INJECTED bracket rather than a module constant', () => {
    // The discriminator against an implementation that hardcodes 0.9: an
    // amended reserve has to move the sizing. Same argument the
    // `round_trip_cost_pct` injection tests above make for their own field
    const doubled: SubclassBracket = {
      ...(ADR_0018_SUBCLASS_BRACKETS.index_etp_3x as SubclassBracket),
      headroom_reserve_fraction: 0.2,
    };

    expect(riskFractionFor(doubled)).toBeCloseTo(0.35 * 0.0216 * 0.8, 9);
  });
});

describe('the reserved headroom is a real tranche, not a rounding artefact (#897)', () => {
  it('reserves 3.5% / 2.5% of equity, clearing the £10 dust floor at the £1,000 book', () => {
    // The floor arithmetic from `SubclassBracket.headroom_reserve_fraction`,
    // asserted rather than only written down. £1,000 is ADR-0015's book.
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
    // Recorded, not engineered away (#897). The single-stock row loses
    // admissibility FIRST despite the smaller envelope, because a smaller
    // envelope reserves less cash — the counter-intuitive half, so it is
    // asserted as an ordering rather than left to a doc comment
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
