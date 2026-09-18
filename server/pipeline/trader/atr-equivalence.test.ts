import {
  type Bar,
  computeIndicator,
  InsufficientBarsError,
} from '../../providers/market-data-service/index.js';
import { atrIndicatorSpec } from './decide.js';

const LOOKBACK = 14;

function LEGACY_TRADER_ATR(bars: Bar[], lookback: number): number | null {
  const [earliest, ...rest] = [...bars].sort(
    (a, b) => a.close_time.getTime() - b.close_time.getTime(),
  );
  if (earliest === undefined || rest.length === 0) return null;

  let previousClose = earliest.close;
  const trueRanges: number[] = [];
  for (const current of rest) {
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(previousClose - current.low),
      ),
    );
    previousClose = current.close;
  }

  const window = trueRanges.slice(-lookback);
  return window.reduce((sum, tr) => sum + tr, 0) / window.length;
}

function mdsAtr(bars: Bar[], lookback: number): number {
  return computeIndicator(bars, atrIndicatorSpec(lookback, '1h'));
}

function pseudoRandomBars(count: number, seed: number): Bar[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };

  const base = new Date('2026-07-15T10:00:00Z').getTime();
  return Array.from({ length: count }, (_, i) => {
    const mid = 100 + (next() - 0.5) * 20;
    const halfRange = next() * 5 + 0.1;
    const closeTime = new Date(base - (count - 1 - i) * 3_600_000);
    return {
      instrument: 'AAPL',
      timeframe: '1h',
      open_time: new Date(closeTime.getTime() - 3_600_000),
      close_time: closeTime,
      open: mid,
      high: mid + halfRange,
      low: mid - halfRange,
      close: mid + (next() - 0.5) * halfRange,
      volume: 1_000,
      source: 'fixture',
    };
  });
}

describe('ATR migration (#304) — Trader’s deleted computeAtr vs MDS computeIndicator', () => {
  it.each([1, 2, 6, 13, LOOKBACK])(
    'agrees exactly for an ATR(%i) over its own lookback + 1 fetch width',
    (lookback) => {
      for (let seed = 1; seed <= 25; seed++) {
        const bars = pseudoRandomBars(lookback + 1, seed);
        const legacy = LEGACY_TRADER_ATR(bars, lookback);
        expect(legacy).not.toBeNull();
        expect(mdsAtr(bars, lookback)).toBeCloseTo(legacy as number, 8);
      }
    },
  );

  it('agrees on the exact fetch width decide.ts uses, to the last bit', () => {
    const bars = pseudoRandomBars(LOOKBACK + 1, 99);
    const legacy = LEGACY_TRADER_ATR(bars, LOOKBACK) as number;

    expect(mdsAtr(bars, LOOKBACK)).toBe(Number(legacy.toFixed(8)));
  });

  it('DIVERGES beyond that width — the boundary that used to make lookback + 1 load-bearing', () => {
    const bars = pseudoRandomBars(LOOKBACK + 6, 7);
    const legacy = LEGACY_TRADER_ATR(bars, LOOKBACK) as number;

    expect(mdsAtr(bars, LOOKBACK)).not.toBeCloseTo(legacy, 6);
  });

  it('THROWS below the seed width where the legacy function fabricated a mean (#319)', () => {
    const oneShort = pseudoRandomBars(LOOKBACK, 3);
    expect(LEGACY_TRADER_ATR(oneShort, LOOKBACK)).toBeCloseTo(
      LEGACY_TRADER_ATR(oneShort, LOOKBACK - 1) as number,
      10,
    );
    expect(() => mdsAtr(oneShort, LOOKBACK)).toThrow(InsufficientBarsError);

    expect(LEGACY_TRADER_ATR(pseudoRandomBars(1, 3), LOOKBACK)).toBeNull();
    expect(() => mdsAtr(pseudoRandomBars(1, 3), LOOKBACK)).toThrow(
      /atr\(14\) needs 15 bars but received 1/,
    );
  });
});
