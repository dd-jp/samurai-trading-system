import { describe, expect, it } from 'vitest';
import { computeDebateId } from './debate-id.js';
import type { AnalystView } from './types.js';

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'analyst-technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.82,
    key_points: ['RSI oversold bounce', 'volume confirms breakout'],
    timestamp: new Date('2026-07-14T09:00:00Z'),
    ...overrides,
  };
}

describe('computeDebateId', () => {
  it('is deterministic: identical inputs always produce the same id', () => {
    const instrument = 'BTC-USD';
    const bar = new Date('2026-07-14T09:00:00Z');
    const views = [makeView()];

    const first = computeDebateId(instrument, bar, views);
    const second = computeDebateId(instrument, bar, views);

    expect(first).toBe(second);
  });

  it('is stable across a simulated crash re-run (fresh AnalystView objects, same content, different trace_id/timestamp)', () => {
    const instrument = 'BTC-USD';
    const bar = new Date('2026-07-14T09:00:00Z');

    const beforeCrash = [
      makeView({ trace_id: 'trace-before-crash', timestamp: new Date('2026-07-14T09:00:00.100Z') }),
    ];
    const afterCrash = [
      makeView({ trace_id: 'trace-after-crash', timestamp: new Date('2026-07-14T09:00:03.400Z') }),
    ];

    expect(computeDebateId(instrument, bar, beforeCrash)).toBe(
      computeDebateId(instrument, bar, afterCrash),
    );
  });

  it('is order-independent over the AnalystView set', () => {
    const instrument = 'BTC-USD';
    const bar = new Date('2026-07-14T09:00:00Z');

    const technical = makeView({ analyst_id: 'analyst-technical-1', analyst_type: 'technical' });
    const sentiment = makeView({
      analyst_id: 'analyst-sentiment-1',
      analyst_type: 'sentiment',
      direction: 'bearish',
      confidence: 0.4,
      key_points: ['negative headline flow'],
    });

    const idInOrder = computeDebateId(instrument, bar, [technical, sentiment]);
    const idReversed = computeDebateId(instrument, bar, [sentiment, technical]);

    expect(idInOrder).toBe(idReversed);
  });

  it('changes when instrument, bar, or view content changes', () => {
    const bar = new Date('2026-07-14T09:00:00Z');
    const views = [makeView()];

    const baseline = computeDebateId('BTC-USD', bar, views);

    expect(computeDebateId('ETH-USD', bar, views)).not.toBe(baseline);
    expect(computeDebateId('BTC-USD', new Date('2026-07-14T09:05:00Z'), views)).not.toBe(baseline);
    expect(computeDebateId('BTC-USD', bar, [makeView({ direction: 'bearish' })])).not.toBe(
      baseline,
    );
  });
});
