import { describe, expect, it } from 'vitest';
import type {
  BookSpec,
  CapitalYear,
  SleeveDecision,
  SleeveSpec,
  V2Bar,
} from '../../../../contracts/index.js';
import { V2RiskGate } from './gate.js';
import { MAX_POSITION_FRACTION_OF_EQUITY } from './position-size.js';

const RUNS = 2_000;
const TRADING_DATE = '2026-09-25';

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Case {
  readonly equityGbp: number;
  readonly startCapitalGbp: number;
  readonly minimumCapitalGbp: number;
  readonly price: number;
  readonly atr: number;
  readonly volume: number;
  readonly fx: number;
  readonly venue: SleeveDecision['venue'];
  readonly variant: BookSpec['variant'];
  readonly macroDay: boolean;
  readonly spec: SleeveSpec;
}

function logUniform(random: () => number, low: number, high: number): number {
  return Math.exp(Math.log(low) + random() * (Math.log(high) - Math.log(low)));
}

function randomCase(random: () => number): Case {
  const startCapitalGbp = logUniform(random, 100, 5_000_000);
  return {
    equityGbp: startCapitalGbp * (0.2 + random() * 1.6),
    startCapitalGbp,
    minimumCapitalGbp: random() < 0.2 ? logUniform(random, 100, 10_000_000) : 0,
    price: logUniform(random, 0.5, 5_000),
    atr: logUniform(random, 0.001, 200),
    volume: random() < 0.05 ? 0 : logUniform(random, 1, 50_000_000),
    fx: 1 + random() * 0.6,
    venue: random() < 0.5 ? 'alpaca' : 'saxo',
    variant: random() < 0.5 ? 'primary' : 'no-macro-gate',
    macroDay: random() < 0.3,
    spec: {
      minimumCapitalGbp: 0,
      capacityGbp: Number.POSITIVE_INFINITY,
      validation: 'forward-paper',
      macroGate: true,
      sizing: {
        riskFraction: logUniform(random, 0.0005, 0.05),
        stopAtrMultiple: 0.5 + random() * 4,
        targetAtrMultiple: 3,
        timeStopTradingDays: 10,
        advShare: logUniform(random, 0.0001, 0.2),
        advWindowBars: 20,
      },
      books: [],
    },
  };
}

function bars(volume: number): V2Bar[] {
  return Array.from({ length: 20 }, (_, index) => ({
    date: `2026-09-${String(5 + index).padStart(2, '0')}`,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume,
    rawClose: 1,
  }));
}

function size(testCase: Case): number {
  const capital: CapitalYear = {
    year: 2026,
    effectiveFrom: '2026-01-01',
    startCapitalGbp: testCase.startCapitalGbp,
    lossCapGbp: 1_500,
  };
  const spec = { ...testCase.spec, minimumCapitalGbp: testCase.minimumCapitalGbp };
  const gate = new V2RiskGate({
    books: { lastDay: () => undefined },
    capital: { inForce: () => capital },
    market: {
      lastBarBefore: () => undefined,
      barsBefore: () => bars(testCase.volume * testCase.price),
      gbpUsdAtYearStart: () => testCase.fx,
    },
    spec: () => spec,
  });
  const book: BookSpec = {
    id: `s/${testCase.variant}`,
    sleeve: 's',
    variant: testCase.variant,
    instantiated: true,
  };
  return gate.approveEntry({
    book,
    decision: {
      sleeve_id: 's',
      instrument: 'X',
      venue: testCase.venue,
      direction: 'bullish',
      confidence: 1,
      action: 'enter_long',
      reason: 'r',
      price: testCase.price,
      atr: testCase.atr,
      stop_price: testCase.price - testCase.spec.sizing.stopAtrMultiple * testCase.atr,
      inputs_hash: 'h',
      debate_id: undefined,
      payload: {},
    },
    clientOrderId: 'c',
    tradingDate: TRADING_DATE,
    equityGbp: testCase.equityGbp,
    macroDay: testCase.macroDay,
  }).size;
}

describe('entry sizing properties (doc 67 Step 3d kill line)', () => {
  const random = mulberry32(1_783);
  const cases = Array.from({ length: RUNS }, () => randomCase(random));

  it('is a non-negative whole number of shares', () => {
    for (const testCase of cases) {
      const shares = size(testCase);
      expect(Number.isInteger(shares) && shares >= 0).toBe(true);
    }
  });

  it('never exceeds the declared share of average daily volume', () => {
    for (const testCase of cases) {
      expect(size(testCase)).toBeLessThanOrEqual(
        testCase.spec.sizing.advShare * testCase.volume * (1 + 1e-9),
      );
    }
  });

  it('never exceeds the equity fraction by notional or by risk at the stop', () => {
    for (const testCase of cases) {
      const shares = size(testCase);
      const quotePerGbp = testCase.venue === 'alpaca' ? testCase.fx : 1;
      const priceGbp = testCase.price / quotePerGbp;
      const stopGbp = (testCase.spec.sizing.stopAtrMultiple * testCase.atr) / quotePerGbp;
      const slack = 1 + 1e-9;
      expect(shares * priceGbp).toBeLessThanOrEqual(
        testCase.equityGbp * MAX_POSITION_FRACTION_OF_EQUITY * slack,
      );
      expect(shares * stopGbp).toBeLessThanOrEqual(
        testCase.equityGbp * testCase.spec.sizing.riskFraction * slack,
      );
    }
  });

  it('is zero whenever the start capital is below the sleeve minimum', () => {
    const starved = cases.filter(
      (testCase) => testCase.startCapitalGbp < testCase.minimumCapitalGbp,
    );
    expect(starved.length).toBeGreaterThan(50);
    for (const testCase of starved) expect(size(testCase)).toBe(0);
  });

  it('binds on volume in some cases and on risk or notional in others', () => {
    const funded = cases.filter((testCase) => testCase.minimumCapitalGbp === 0);
    const volumeBound = funded.filter(
      (testCase) => size(testCase) === Math.floor(testCase.spec.sizing.advShare * testCase.volume),
    );
    expect(volumeBound.length).toBeGreaterThan(50);
    expect(funded.length - volumeBound.length).toBeGreaterThan(50);
  });
});
