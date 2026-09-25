import {
  DAILY_CAP_FRACTION_OF_START_CAPITAL,
  dailyCapBreached,
  LOSS_BUDGET_STEPS,
  LossBudget,
  sizeMultiplierFor,
} from './loss-budget.js';

describe('sizeMultiplierFor', () => {
  it('steps at exactly -500, -1000 and -1500 GBP', () => {
    expect(LOSS_BUDGET_STEPS).toEqual({
      halfSizeAtGbp: 500,
      quarterSizeAtGbp: 1_000,
      haltAtGbp: 1_500,
    });
    expect(sizeMultiplierFor(499.99)).toBe(1);
    expect(sizeMultiplierFor(500)).toBe(0.5);
    expect(sizeMultiplierFor(999.99)).toBe(0.5);
    expect(sizeMultiplierFor(1_000)).toBe(0.25);
    expect(sizeMultiplierFor(1_499.99)).toBe(0.25);
    expect(sizeMultiplierFor(1_500)).toBe(0);
  });

  it('treats a gain as full size', () => {
    expect(sizeMultiplierFor(-300)).toBe(1);
  });

  it('rejects steps that are not strictly ascending from zero', () => {
    expect(() =>
      sizeMultiplierFor(0, { halfSizeAtGbp: 0, quarterSizeAtGbp: 1, haltAtGbp: 2 }),
    ).toThrow(/0 < half < quarter < halt/);
    expect(() =>
      sizeMultiplierFor(0, { halfSizeAtGbp: 5, quarterSizeAtGbp: 5, haltAtGbp: 6 }),
    ).toThrow(/0 < half < quarter < halt/);
    expect(() =>
      sizeMultiplierFor(0, { halfSizeAtGbp: 5, quarterSizeAtGbp: 6, haltAtGbp: 6 }),
    ).toThrow(/0 < half < quarter < halt/);
  });
});

describe('dailyCapBreached', () => {
  it('breaches at exactly 1% of start capital', () => {
    expect(DAILY_CAP_FRACTION_OF_START_CAPITAL).toBe(0.01);
    expect(dailyCapBreached(9.99, 1_000)).toBe(false);
    expect(dailyCapBreached(10, 1_000)).toBe(true);
    expect(dailyCapBreached(50, 5_000)).toBe(true);
  });

  it('rejects a non-positive start capital', () => {
    expect(() => dailyCapBreached(1, 0)).toThrow(/startCapitalGbp/);
  });
});

describe('LossBudget', () => {
  it('measures the year-to-date loss from the reference equity, not the previous close', () => {
    const budget = new LossBudget(1_000);
    expect(budget.markClose(700, 1_000)).toEqual({
      referenceEquityGbp: 1_000,
      ytdLossGbp: 300,
      sizeMultiplier: 1,
      halted: false,
      entriesBlockedAtNextFill: true,
    });
    expect(budget.markClose(495, 700).sizeMultiplier).toBe(0.5);
    expect(budget.markClose(0, 495).sizeMultiplier).toBe(0.25);
  });

  it('latches the halt for the year even after equity recovers', () => {
    const budget = new LossBudget(5_000);
    const halted = budget.markClose(3_500, 5_000);
    expect(halted.halted).toBe(true);
    expect(halted.sizeMultiplier).toBe(0);
    const recovered = budget.markClose(5_500, 3_500);
    expect(recovered.halted).toBe(true);
    expect(recovered.sizeMultiplier).toBe(0);
    expect(recovered.entriesBlockedAtNextFill).toBe(true);
  });

  it('resets the reference to the year-start equity and clears the halt', () => {
    const budget = new LossBudget(5_000);
    budget.markClose(3_500, 5_000);
    budget.resetYear(3_500);
    const state = budget.markClose(3_400, 3_500);
    expect(state).toEqual({
      referenceEquityGbp: 3_500,
      ytdLossGbp: 100,
      sizeMultiplier: 1,
      halted: false,
      entriesBlockedAtNextFill: true,
    });
  });

  it('keeps the daily cap on start capital rather than the rebased reference', () => {
    const budget = new LossBudget(1_000);
    budget.resetYear(10_000);
    expect(budget.markClose(9_991, 10_000).entriesBlockedAtNextFill).toBe(false);
    expect(budget.markClose(9_981, 9_991).entriesBlockedAtNextFill).toBe(true);
  });

  it('rejects steps that are not ascending at construction', () => {
    expect(
      () => new LossBudget(1_000, { halfSizeAtGbp: 5, quarterSizeAtGbp: 4, haltAtGbp: 6 }),
    ).toThrow(/0 < half < quarter < halt/);
  });

  it('rejects a non-positive start capital', () => {
    expect(() => new LossBudget(0)).toThrow(/startCapitalGbp/);
  });
});
