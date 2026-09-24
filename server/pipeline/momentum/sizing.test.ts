import {
  adjustedQuantity,
  annualisedVolatility,
  equalWeights,
  inverseVolatilityWeights,
  TRADING_DAYS_PER_YEAR,
  WHOLE_SHARE_TOLERANCE_MULTIPLE,
  wholeShares,
  withinWholeShareTolerance,
} from './sizing.js';

describe('wholeShares', () => {
  it('floors cash over the raw price', () => {
    expect(wholeShares(1000, 333)).toBe(3);
    expect(wholeShares(999, 333)).toBe(3);
    expect(wholeShares(998, 333)).toBe(2);
  });

  it('is zero when the raw price exceeds the cash or either input is not positive', () => {
    expect(wholeShares(100, 101)).toBe(0);
    expect(wholeShares(0, 10)).toBe(0);
    expect(wholeShares(100, 0)).toBe(0);
    expect(wholeShares(-5, 10)).toBe(0);
  });
});

describe('wholeShares at the boundaries', () => {
  it('is zero for zero cash and one for cash equal to the price', () => {
    expect(wholeShares(0, 1)).toBe(0);
    expect(wholeShares(10, 10)).toBe(1);
  });
});

describe('adjustedQuantity', () => {
  it('scales raw shares by raw over adjusted price so a split leaves value unchanged', () => {
    expect(adjustedQuantity(3, 100, 25)).toBe(12);
    expect(adjustedQuantity(3, 100, 100)).toBe(3);
  });

  it('rejects non-positive prices', () => {
    expect(() => adjustedQuantity(1, 0, 10)).toThrow(/prices must be > 0/);
    expect(() => adjustedQuantity(1, 10, 0)).toThrow(/prices must be > 0/);
  });
});

describe('withinWholeShareTolerance', () => {
  it('applies R3: price at most capital over five times the holdings count', () => {
    expect(WHOLE_SHARE_TOLERANCE_MULTIPLE).toBe(5);
    expect(withinWholeShareTolerance(20, 1000, 10)).toBe(true);
    expect(withinWholeShareTolerance(20.01, 1000, 10)).toBe(false);
  });

  it('accepts exactly one holding', () => {
    expect(withinWholeShareTolerance(200, 1000, 1)).toBe(true);
  });

  it('rejects fewer than one holding', () => {
    expect(() => withinWholeShareTolerance(1, 1000, 0)).toThrow(/holdings/);
  });
});

describe('annualisedVolatility', () => {
  it('is the sample stdev scaled by root trading days', () => {
    const returns = [0.01, -0.01, 0.02, -0.02];
    const mean = 0;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 3;
    expect(annualisedVolatility(returns)).toBeCloseTo(
      Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR),
    );
  });

  it('accepts exactly two returns', () => {
    expect(annualisedVolatility([0.01, -0.01])).toBeGreaterThan(0);
  });

  it('is zero for a constant series and rejects fewer than two returns', () => {
    expect(annualisedVolatility([0.01, 0.01, 0.01])).toBe(0);
    expect(() => annualisedVolatility([0.01])).toThrow(/need >= 2/);
  });
});

describe('inverseVolatilityWeights', () => {
  it('sizes each name at target over its own volatility when the gross cap is slack', () => {
    const weights = inverseVolatilityWeights(
      new Map([
        ['A', 0.2],
        ['B', 0.4],
      ]),
      0.1,
      1,
    );
    expect(weights.get('A')).toBeCloseTo(0.5);
    expect(weights.get('B')).toBeCloseTo(0.25);
  });

  it('scales down proportionally when the gross would exceed the cap', () => {
    const weights = inverseVolatilityWeights(
      new Map([
        ['A', 0.1],
        ['B', 0.1],
      ]),
      0.1,
      1,
    );
    expect(weights.get('A')).toBeCloseTo(0.5);
    expect(weights.get('B')).toBeCloseTo(0.5);
  });

  it('leaves weights untouched when the gross equals the cap exactly', () => {
    const weights = inverseVolatilityWeights(
      new Map([
        ['A', 0.2],
        ['B', 0.2],
      ]),
      0.1,
      1,
    );
    expect(weights.get('A')).toBe(0.5);
    expect(weights.get('B')).toBe(0.5);
  });

  it('drops a name with zero or negative volatility and rejects a bad target or cap', () => {
    expect(inverseVolatilityWeights(new Map([['A', 0]]), 0.1, 1).size).toBe(0);
    expect(() => inverseVolatilityWeights(new Map(), 0, 1)).toThrow(/targetVolatility/);
    expect(() => inverseVolatilityWeights(new Map([['A', 0.05]]), 0.1, 0)).toThrow(/grossCap/);
  });
});

describe('equalWeights', () => {
  it('splits the gross cap evenly and is empty for no symbols', () => {
    expect([...equalWeights(['A', 'B', 'C', 'D'], 1).values()]).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(equalWeights([], 1).size).toBe(0);
  });
});
