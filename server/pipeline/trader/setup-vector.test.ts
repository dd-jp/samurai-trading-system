/**
 * Setup-vector embedding tests (#432). The vector is what makes cosine
 * retrieval mean anything, so these pin the two properties the retrieval
 * depends on: scale-invariance across instruments, and a stable feature
 * layout.
 */

import type { Bar } from '../../providers/market-data-service/index.js';
import type { DebateResult } from '../debate-engine/index.js';
import { cosineSimilarity } from './cosine-precedent.js';
import { buildSetupVector, type SetupMarketContext } from './setup-vector.js';

function bars(closes: number[]): Bar[] {
  return closes.map((close, i) => ({
    instrument: 'AAPL',
    timeframe: '1h',
    open_time: new Date(Date.UTC(2026, 6, 15, i)),
    close_time: new Date(Date.UTC(2026, 6, 15, i + 1)),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
    source: 'fixture',
  }));
}

function debate(overrides: Partial<DebateResult> = {}): DebateResult {
  return {
    synthesis: '',
    position: '',
    confidence: 0.8,
    contributions: [],
    disagreement_summary: '',
    open_items: [],
    converged: true,
    rounds_completed: 2,
    latency_ms: 1000,
    direction: 'bullish',
    debate_id: 'debate-1',
    ...overrides,
  };
}

function contribution(final_position: 'bullish' | 'bearish' | 'neutral') {
  return {
    analyst_id: `a-${final_position}`,
    analyst_type: 'technical',
    stance_during_debate: [final_position],
    final_position,
    rationale: '',
    influence_score: 0.5,
  };
}

const MARKET: SetupMarketContext = {
  entry: 100,
  atr: 2,
  stopDistance: 4,
  bars: bars([98, 99, 100]),
};

describe('buildSetupVector', () => {
  it('lays the debate features out in the documented order', () => {
    const vector = buildSetupVector(
      debate({ confidence: 0.8, direction: 'bullish', converged: true }),
      MARKET,
    );

    expect(vector.debate_features).toEqual([0.8, 1, 1, 0]);
  });

  it('signs the direction feature so bullish and bearish are opposed', () => {
    const bull = buildSetupVector(debate({ direction: 'bullish' }), MARKET);
    const bear = buildSetupVector(debate({ direction: 'bearish' }), MARKET);

    expect(bull.debate_features[1]).toBe(1);
    expect(bear.debate_features[1]).toBe(-1);
  });

  it('scores disagreement as the dissenting share of contributions', () => {
    const vector = buildSetupVector(
      debate({
        direction: 'bullish',
        contributions: [
          contribution('bullish'),
          contribution('bullish'),
          contribution('bearish'),
          contribution('neutral'),
        ],
      }),
      MARKET,
    );

    expect(vector.debate_features[3]).toBe(0.5);
  });

  it('scores a contribution-free debate as zero disagreement, not NaN', () => {
    const vector = buildSetupVector(debate({ contributions: [] }), MARKET);

    expect(vector.debate_features[3]).toBe(0);
  });

  it('expresses market features as fractions of price', () => {
    const vector = buildSetupVector(debate(), MARKET);

    // atr/entry, trend over the window, stopDistance/entry
    expect(vector.market_features[0]).toBeCloseTo(0.02, 10);
    expect(vector.market_features[1]).toBeCloseTo((100 - 98) / 98, 10);
    expect(vector.market_features[2]).toBeCloseTo(0.04, 10);
  });

  it('embeds two instruments at different price levels identically when the setup is the same', () => {
    // The whole point of dividing by entry. A raw-price ATR would put BTC and
    // AAPL in different regions of the space no matter how alike the setups.
    const aapl = buildSetupVector(debate(), {
      entry: 100,
      atr: 2,
      stopDistance: 4,
      bars: bars([98, 99, 100]),
    });
    const btc = buildSetupVector(debate(), {
      entry: 50_000,
      atr: 1_000,
      stopDistance: 2_000,
      bars: bars([49_000, 49_500, 50_000]),
    });

    expect(btc.market_features).toEqual(aapl.market_features);
    expect(
      cosineSimilarity(
        [...aapl.debate_features, ...aapl.market_features],
        [...btc.debate_features, ...btc.market_features],
      ),
    ).toBeCloseTo(1, 10);
  });

  it('returns a zero trend rather than Infinity when the first close is zero', () => {
    const vector = buildSetupVector(debate(), { ...MARKET, bars: bars([0, 1, 2]) });

    expect(vector.market_features[1]).toBe(0);
  });

  it('returns a zero trend on an empty bar window', () => {
    const vector = buildSetupVector(debate(), { ...MARKET, bars: [] });

    expect(vector.market_features[1]).toBe(0);
  });

  it('separates a floored setup from a genuinely quiet one', () => {
    // Same tiny ATR; one had the vol floor engaged and one did not. If the
    // stop-width feature were dropped these would be indistinguishable.
    const quiet = buildSetupVector(debate(), { ...MARKET, atr: 0.01, stopDistance: 0.02 });
    const floored = buildSetupVector(debate(), { ...MARKET, atr: 0.01, stopDistance: 0.4 });

    expect(quiet.market_features[2]).not.toBe(floored.market_features[2]);
  });
});
