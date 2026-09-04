import { describe, expect, it } from 'vitest';
import { makeDebate, makeFill, makeRiskCritic } from '../test-fixtures.ts';
import { doneThrough, makeView } from './test-support.ts';
import { fillsFor, laneFor, latestDebateFor, riskCriticFor, riskCriticForDebate } from './trace.ts';

describe('laneFor', () => {
  const view = makeView([
    doneThrough('ETH-USD', 'trace-new', 'execution', { outcome: 'go' }),
    doneThrough('SPY', 'trace-spy', 'risk', { outcome: 'stopped' }),
  ]);

  it('resolves by instrument when no trace is pinned', () => {
    expect(laneFor(view, 'SPY', null)?.trace_id).toBe('trace-spy');
  });

  it('resolves by trace id when one is pinned, and finds nothing for an aged-out trace', () => {
    expect(laneFor(view, 'ETH-USD', 'trace-new')?.instrument).toBe('ETH-USD');
    expect(laneFor(view, 'ETH-USD', 'trace-old')).toBeUndefined();
  });
});

describe('riskCriticFor', () => {
  it('matches BOTH trace and instrument, never one alone', () => {
    const rows = [
      makeRiskCritic({ trace_id: 't1', instrument: 'QQQ' }),
      makeRiskCritic({ trace_id: 't1', instrument: 'SPY' }),
    ];
    expect(riskCriticFor(rows, 't1', 'SPY')?.instrument).toBe('SPY');
    expect(riskCriticFor(rows, 't1', 'AAPL')).toBeUndefined();
    expect(riskCriticFor(rows, null, 'SPY')).toBeUndefined();
  });

  it('joins a closed trade to its critic row by debate_id', () => {
    const rows = [makeRiskCritic({ debate_id: 'd-1' }), makeRiskCritic({ debate_id: 'd-2' })];
    expect(riskCriticForDebate(rows, 'd-2')?.debate_id).toBe('d-2');
  });
});

describe('latestDebateFor / fillsFor', () => {
  it('takes the first (newest) debate for the instrument', () => {
    const debates = [
      makeDebate({ debate_id: 'newest', instrument: 'SPY' }),
      makeDebate({ debate_id: 'older', instrument: 'SPY' }),
    ];
    expect(latestDebateFor(debates, 'SPY')?.debate_id).toBe('newest');
  });

  it('returns only the fills under one order key', () => {
    const fills = [
      makeFill({ idempotency_key: 'k1', broker_fill_id: 'f1' }),
      makeFill({ idempotency_key: 'k2', broker_fill_id: 'f2' }),
    ];
    expect(fillsFor(fills, 'k1').map((fill) => fill.broker_fill_id)).toEqual(['f1']);
  });
});
