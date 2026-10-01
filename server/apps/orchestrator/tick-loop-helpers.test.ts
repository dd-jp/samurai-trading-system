import { describe, expect, it } from 'vitest';
import type { DecisionGate } from './decision-bar-gate.js';
import {
  barForfeitMessage,
  claimDecisionBar,
  decisionBarField,
  readCrashedStage,
} from './tick-loop.js';
import type { CurrentTick, CurrentTickStore, DecisionBar } from './types.js';

const TICK = new Date('2026-07-15T14:00:00Z');
const BAR: DecisionBar = { id: 'bar-1', open_time: TICK, timeframe_ms: 60_000 };

function gate(): DecisionGate & { claims: [string, Date][] } {
  const claims: [string, Date][] = [];
  return {
    claims,
    claim: (instrument, tickTime) => {
      claims.push([instrument, tickTime]);
      return BAR;
    },
    rescind: () => 'retried',
  };
}

function store(row: CurrentTick | undefined | Error): CurrentTickStore {
  return {
    upsert: () => undefined,
    delete: () => undefined,
    get: () => {
      if (row instanceof Error) throw row;
      return row;
    },
  };
}

const PASS = { instrument: { asset: 'AAPL', asset_class: 'stocks' as const }, trace_id: 't-1' };

describe('claimDecisionBar', () => {
  it('claims the bar at the tick time on a normal tick', () => {
    const decisionGate = gate();
    expect(claimDecisionBar({ instruments: [], tick_time: TICK }, decisionGate, 'AAPL')).toBe(BAR);
    expect(decisionGate.claims).toEqual([['AAPL', TICK]]);
  });

  it('claims nothing on a grace-only tick', () => {
    const decisionGate = gate();
    const plan = { instruments: [], tick_time: TICK, grace_only: true };
    expect(claimDecisionBar(plan, decisionGate, 'AAPL')).toBeUndefined();
    expect(decisionGate.claims).toEqual([]);
  });
});

describe('decisionBarField', () => {
  it('omits the field when no bar was claimed', () => {
    expect(decisionBarField(undefined)).toEqual({});
  });

  it('carries a claimed bar', () => {
    expect(decisionBarField(BAR)).toEqual({ decision_bar: BAR });
  });
});

describe('barForfeitMessage', () => {
  it('explains a refusal as deterministic', () => {
    expect(barForfeitMessage(true, 'AAPL', 'bar-1')).toBe(
      'decision pass refused by the provider, bar forfeit: AAPL — bar bar-1 will run the tick ' +
        'path only for its remainder, and no retry is attempted because the refusal is ' +
        'deterministic in the request',
    );
  });

  it('explains an exhausted retry budget', () => {
    expect(barForfeitMessage(false, 'AAPL', 'bar-1')).toBe(
      'decision pass retry budget exhausted, bar forfeit: AAPL — bar bar-1 will run the tick ' +
        'path only for its remainder',
    );
  });
});

describe('readCrashedStage', () => {
  const row: CurrentTick = {
    instrument: 'AAPL',
    asset_class: 'stocks',
    stage: 'debate',
    trace_id: 't-1',
    updated_at: TICK,
  };

  it("reads the stage this pass's trace reached", () => {
    expect(readCrashedStage(store(row), PASS)).toBe('debate');
  });

  it("ignores another pass's row", () => {
    expect(readCrashedStage(store({ ...row, trace_id: 't-2' }), PASS)).toBeUndefined();
  });

  it('reads nothing when no row exists', () => {
    expect(readCrashedStage(store(undefined), PASS)).toBeUndefined();
  });

  it('swallows a store read failure', () => {
    expect(readCrashedStage(store(new Error('locked')), PASS)).toBeUndefined();
  });
});
