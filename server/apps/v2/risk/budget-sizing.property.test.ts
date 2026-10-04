import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CapitalYear, SleeveSpec, V2Bar } from '../../../../contracts/index.js';
import { addDays, MACRO_DAY_SIZE_FRACTION } from '../data/index.js';
import { sleeveCapitalYear } from './allocation.js';
import {
  dailyCapBreached,
  dailyCapGbp,
  LossBudget,
  sizeMultiplierFor,
  sizeStepMarksGbp,
} from './loss-budget.js';
import {
  CFD_SHORT_GAP_FRACTION,
  MAX_POSITION_FRACTION_OF_EQUITY,
  type PositionSizeInput,
  positionSizeShares,
} from './position-size.js';
import { averageDailyNotional, volumeCapShares } from './volume-cap.js';

const SLACK = 1 + 1e-9;
const STEPS = [1, 0.5, 0.25, 0] as const;

const pence = fc.integer({ min: 0, max: 100_000_000 });
const capPounds = fc.integer({ min: 1, max: 1_000_000 });
const positive = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

function capital(startCapitalGbp: number, lossCapGbp: number): CapitalYear {
  return { year: 2026, effectiveFrom: '2026-01-01', startCapitalGbp, lossCapGbp };
}

// Integer oracle for doc 66 G6: −⅓ of the cap → ½, −⅔ → ¼, the whole cap → halt. The cap is whole
// pounds, as the yearly config is set: against a cap in pence the float mark cap/3 can sit one ulp
// above a loss equal to it (cap 89,955.30, loss 29,985.10 reads as full size)
function rulingMultiplier(lossPence: number, capGbp: number): number {
  if (lossPence >= 100 * capGbp) return 0;
  if (3 * lossPence >= 200 * capGbp) return 0.25;
  if (3 * lossPence >= 100 * capGbp) return 0.5;
  return 1;
}

describe('loss-budget steps (doc 66 G6, D8)', () => {
  it('matches the ruling at every whole-penny loss against any whole-penny cap', () => {
    fc.assert(
      fc.property(pence, capPounds, (loss, cap) => {
        expect(sizeMultiplierFor(loss / 100, cap)).toBe(rulingMultiplier(loss, cap));
      }),
    );
  });

  it('matches the ruling a penny either side of each step mark', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 300_000 }),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: -1, max: 1 }),
        (third, step, nudge) => {
          const cap = 3 * third;
          const loss = 100 * step * third + nudge;
          expect(sizeMultiplierFor(loss / 100, cap)).toBe(rulingMultiplier(loss, cap));
        },
      ),
    );
  });

  it('never gives a larger size for a larger loss', () => {
    fc.assert(
      fc.property(positive(-1e7, 1e7), positive(-1e7, 1e7), positive(0.01, 1e6), (a, b, cap) => {
        const [smaller, larger] = a <= b ? [a, b] : [b, a];
        expect(sizeMultiplierFor(larger, cap)).toBeLessThanOrEqual(sizeMultiplierFor(smaller, cap));
      }),
    );
  });

  it('is full size on a gain and only ever one of the four ruled steps', () => {
    fc.assert(
      fc.property(positive(-1e7, 1e7), positive(0.01, 1e6), (loss, cap) => {
        const multiplier = sizeMultiplierFor(loss, cap);
        expect(STEPS).toContain(multiplier);
        if (loss <= 0) expect(multiplier).toBe(1);
      }),
    );
  });

  it("steps a sleeve against its capital share of the cap, so the sleeves' caps sum to at most the account's", () => {
    fc.assert(
      fc.property(
        fc.array(positive(0.01, 1), { minLength: 1, maxLength: 5 }),
        positive(100, 1e7),
        positive(1, 1e5),
        (weights, start, cap) => {
          const total = weights.reduce((sum, weight) => sum + weight, 0);
          const shares = weights.map((weight) => weight / Math.max(total, 1));
          const account = capital(start, cap);
          const sleeves = shares.map((capitalShare) =>
            sleeveCapitalYear({ capitalShare } as SleeveSpec, account),
          );
          const summed = sleeves.reduce((sum, sleeve) => sum + sleeve.lossCapGbp, 0);
          expect(summed).toBeLessThanOrEqual(cap * SLACK);
          sleeves.forEach((sleeve, index) => {
            const share = shares[index] as number;
            expect(sleeve.lossCapGbp).toBeCloseTo(cap * share, 6);
            expect(dailyCapGbp(sleeve)).toBeCloseTo(0.01 * start * share, 6);
            const [half, quarter, halt] = sizeStepMarksGbp(sleeve.lossCapGbp);
            expect(sizeMultiplierFor(half, sleeve.lossCapGbp)).toBe(0.5);
            expect(sizeMultiplierFor(quarter, sleeve.lossCapGbp)).toBe(0.25);
            expect(sizeMultiplierFor(halt, sleeve.lossCapGbp)).toBe(0);
          });
        },
      ),
    );
  });

  it('breaches the daily cap exactly from 1% of start capital, and more loss stays breached', () => {
    fc.assert(
      fc.property(pence, fc.integer({ min: 100, max: 1_000_000_000 }), (dayLoss, start) => {
        expect(dailyCapBreached(dayLoss / 100, capital(start / 100, 1_500))).toBe(
          100 * dayLoss >= start,
        );
      }),
    );
  });

  it('over any year of closes: loss is reference minus equity, a halt sticks, and the daily cap blocks', () => {
    fc.assert(
      fc.property(
        positive(1_000, 1e6),
        positive(1, 1e5),
        fc.array(positive(-0.2, 0.2), { minLength: 1, maxLength: 60 }),
        (start, cap, returns) => {
          const year = capital(start, cap);
          const budget = new LossBudget(start);
          let previous = start;
          let haltedBefore = false;
          for (const change of returns) {
            const equity = previous * (1 + change);
            const state = budget.markClose(equity, previous, year);
            expect(state.referenceEquityGbp).toBe(start);
            expect(state.ytdLossGbp).toBe(start - equity);
            const halted: boolean = haltedBefore || state.ytdLossGbp >= cap;
            expect(state.halted).toBe(halted);
            expect(state.sizeMultiplier).toBe(halted ? 0 : sizeMultiplierFor(start - equity, cap));
            expect(state.entriesBlockedAtNextFill).toBe(
              halted || previous - equity >= 0.01 * start,
            );
            haltedBefore = halted;
            previous = equity;
          }
        },
      ),
    );
  });

  it('a year reset lifts any halt and measures from the equity it is given, never the original seed', () => {
    fc.assert(
      fc.property(
        positive(1_000, 1e6),
        positive(1, 1e5),
        positive(0, 2),
        positive(0.5, 1.5),
        (start, cap, firstYear, nextYear) => {
          const budget = new LossBudget(start);
          const yearEnd = start * firstYear;
          budget.markClose(yearEnd, start, capital(start, cap));
          budget.resetYear(yearEnd);
          const equity = yearEnd * nextYear;
          const state = budget.markClose(equity, yearEnd, capital(start, cap));
          expect(state.referenceEquityGbp).toBe(yearEnd);
          expect(state.ytdLossGbp).toBe(yearEnd - equity);
          expect(state.halted).toBe(yearEnd - equity >= cap);
        },
      ),
    );
  });
});

const sizing = fc.record({
  equityGbp: positive(-1e5, 1e8),
  riskFraction: positive(0.0001, 0.05),
  priceGbp: positive(0.01, 10_000),
  atrGbp: positive(0, 500),
  stopAtrMultiple: positive(0.25, 5),
  sizeMultiplier: fc.constantFrom(...STEPS),
  macroDay: fc.boolean(),
  volumeCapShares: fc.oneof(
    fc.integer({ min: 0, max: 10_000_000 }),
    fc.constant(Number.POSITIVE_INFINITY),
  ),
  gapBudgetGbp: fc.option(positive(0, 1_000), { nil: undefined }),
  entryToStopGbp: fc.option(positive(0, 1_000), { nil: undefined }),
});

const unconstrained = sizing.map(
  (input): PositionSizeInput => ({
    ...input,
    equityGbp: Math.abs(input.equityGbp),
    volumeCapShares: Number.POSITIVE_INFINITY,
    gapBudgetGbp: undefined,
  }),
);

function scaleOf(input: PositionSizeInput): number {
  return input.sizeMultiplier * (input.macroDay ? MACRO_DAY_SIZE_FRACTION : 1);
}

describe('positionSizeShares bounds (doc 66 D8, Q13)', () => {
  it('is a non-negative whole number of shares for any input', () => {
    fc.assert(
      fc.property(sizing, (input) => {
        const shares = positionSizeShares(input);
        expect(Number.isInteger(shares)).toBe(true);
        expect(shares).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('never exceeds the volume cap, the notional cap, the risk budget or the CFD short gap budget', () => {
    fc.assert(
      fc.property(sizing, (input) => {
        const shares = positionSizeShares(input);
        const scale = scaleOf(input);
        const riskPerShare = Math.max(
          input.atrGbp * input.stopAtrMultiple,
          input.entryToStopGbp ?? 0,
        );
        expect(shares).toBeLessThanOrEqual(input.volumeCapShares);
        expect(shares * input.priceGbp).toBeLessThanOrEqual(
          Math.max(0, input.equityGbp * MAX_POSITION_FRACTION_OF_EQUITY * scale) * SLACK,
        );
        expect(shares * riskPerShare).toBeLessThanOrEqual(
          Math.max(0, input.equityGbp * input.riskFraction * scale) * SLACK,
        );
        if (input.gapBudgetGbp !== undefined) {
          expect(shares * input.priceGbp * CFD_SHORT_GAP_FRACTION).toBeLessThanOrEqual(
            input.gapBudgetGbp * SLACK,
          );
        }
      }),
    );
  });

  it('is zero under a halt and with no measurable stop distance', () => {
    fc.assert(
      fc.property(sizing, (input) => {
        expect(positionSizeShares({ ...input, sizeMultiplier: 0 })).toBe(0);
        expect(positionSizeShares({ ...input, atrGbp: 0 })).toBe(0);
      }),
    );
  });

  it('never grows with a smaller multiplier, a macro day, less equity or a tighter volume cap', () => {
    fc.assert(
      fc.property(
        sizing,
        positive(0, 1),
        fc.integer({ min: 0, max: 10_000_000 }),
        (input, k, cap) => {
          const shares = positionSizeShares(input);
          for (const step of STEPS.filter((candidate) => candidate <= input.sizeMultiplier)) {
            expect(positionSizeShares({ ...input, sizeMultiplier: step })).toBeLessThanOrEqual(
              shares,
            );
          }
          expect(positionSizeShares({ ...input, macroDay: true })).toBeLessThanOrEqual(
            positionSizeShares({ ...input, macroDay: false }),
          );
          const less = positionSizeShares({ ...input, equityGbp: input.equityGbp * k });
          expect(less).toBeLessThanOrEqual(input.equityGbp >= 0 ? shares : 0);
          expect(
            positionSizeShares({
              ...input,
              volumeCapShares: Math.min(cap, input.volumeCapShares),
            }),
          ).toBeLessThanOrEqual(shares);
        },
      ),
    );
  });

  it('half and quarter size are the full size halved and quartered, rounded down, when only equity binds', () => {
    fc.assert(
      fc.property(unconstrained, (input) => {
        const full = positionSizeShares({ ...input, sizeMultiplier: 1 });
        expect(positionSizeShares({ ...input, sizeMultiplier: 0.5 })).toBe(Math.floor(full / 2));
        expect(positionSizeShares({ ...input, sizeMultiplier: 0.25 })).toBe(Math.floor(full / 4));
      }),
    );
  });

  it('scales with equity: k times the equity buys k times the shares, within rounding', () => {
    fc.assert(
      fc.property(unconstrained, fc.constantFrom(2, 4, 8, 16), (input, k) => {
        const base = positionSizeShares(input);
        const scaled = positionSizeShares({ ...input, equityGbp: input.equityGbp * k });
        expect(scaled).toBeGreaterThanOrEqual(k * base);
        expect(scaled).toBeLessThanOrEqual(k * base + k - 1);
      }),
    );
  });
});

function flatBars(count: number, close: number, volume: number, lastDate: string): V2Bar[] {
  return Array.from({ length: count }, (_, index) => ({
    date: addDays(lastDate, index - count + 1),
    open: close,
    high: close,
    low: close,
    close,
    volume,
    rawClose: close,
  }));
}

describe('volume cap bounds', () => {
  it('is a non-negative whole number never above the declared share of average notional', () => {
    fc.assert(
      fc.property(
        positive(0, 1e12),
        positive(0, 1),
        positive(0.0001, 1e5),
        (notional, share, price) => {
          const shares = volumeCapShares(notional, share, price);
          expect(Number.isInteger(shares)).toBe(true);
          expect(shares).toBeGreaterThanOrEqual(0);
          expect(shares * price).toBeLessThanOrEqual(share * notional * SLACK);
        },
      ),
    );
  });

  it('grows with notional and share, shrinks with price, and refuses a non-finite result as zero', () => {
    fc.assert(
      fc.property(
        positive(0, 1e12),
        positive(0, 1),
        positive(0.0001, 1e5),
        positive(1, 4),
        (notional, share, price, k) => {
          const shares = volumeCapShares(notional, share, price);
          expect(volumeCapShares(notional * k, share, price)).toBeGreaterThanOrEqual(shares);
          expect(volumeCapShares(notional, Math.min(1, share * k), price)).toBeGreaterThanOrEqual(
            shares,
          );
          expect(volumeCapShares(notional, share, price * k)).toBeLessThanOrEqual(shares);
          expect(volumeCapShares(notional, share, 0)).toBe(0);
          expect(volumeCapShares(Number.NaN, share, price)).toBe(0);
        },
      ),
    );
  });

  it('reads no average from fewer bars than the window (postmortem §2 coverage invariant)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 0, max: 60 }),
        positive(0.01, 1_000),
        positive(0, 1e8),
        (window, count, close, volume) => {
          const bars = flatBars(count, close, volume, '2026-09-24');
          const average = averageDailyNotional(bars, window, '2026-09-25');
          if (count < window) expect(average).toBeUndefined();
          else
            expect(Math.abs((average as number) - close * volume)).toBeLessThanOrEqual(
              close * volume * 1e-12,
            );
        },
      ),
    );
  });
});
