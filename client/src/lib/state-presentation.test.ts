import type {
  CloseReason,
  InvalidationConditionStateWire,
  PipelineCellState,
  RiskCriticRow,
} from '@contracts';
import { describe, expect, it } from 'vitest';
import {
  type Presented,
  presentCell,
  presentCloseReason,
  presentCondition,
  presentCriticVerdict,
} from './state-presentation.ts';

/**
 * Typing each expectation table as `Record<Wire, Presented>` makes the test
 * fail `tsc` (not just at runtime) the moment a wire enum grows a member the
 * presenter has not been taught — the actual invariant this module exists to
 * buy back from the old parallel-table shape.
 */

describe('presentCell', () => {
  const inFlightExpectations: Record<PipelineCellState, Presented> = {
    done: { word: 'done', tone: 'done' },
    live: { word: 'live', tone: 'live' },
    stopped: { word: 'stopped', tone: 'stop' },
    skipped: { word: 'skipped', tone: 'skip' },
    // A cell ahead of an in-flight tick reads as "wait", not "not reached".
    not_reached: { word: 'wait', tone: 'wait' },
  };

  it('pairs word and tone for every cell state while the lane is in flight', () => {
    for (const [state, expected] of Object.entries(inFlightExpectations)) {
      expect(presentCell(state as PipelineCellState, 'in_flight')).toEqual(expected);
    }
  });

  it('reads a not-reached cell as settled once the lane has stopped', () => {
    expect(presentCell('not_reached', 'go')).toEqual({ word: 'not reached', tone: 'wait' });
    expect(presentCell('not_reached', 'no_go')).toEqual({ word: 'not reached', tone: 'wait' });
    expect(presentCell('not_reached', 'stopped')).toEqual({ word: 'not reached', tone: 'wait' });
    expect(presentCell('not_reached', 'quorum_skip')).toEqual({
      word: 'not reached',
      tone: 'wait',
    });
  });

  it('reads every cell as idle when the lane itself is idle, regardless of cell state', () => {
    const states: PipelineCellState[] = ['done', 'live', 'stopped', 'skipped', 'not_reached'];
    for (const state of states) {
      expect(presentCell(state, 'idle')).toEqual({ word: 'idle', tone: expectedIdleTone(state) });
    }
  });

  function expectedIdleTone(state: PipelineCellState): Presented['tone'] {
    // The tone tracks the cell's own state even when the lane is idle and the
    // word is overridden to "idle" — only the word carries the lane-level fact.
    return inFlightExpectations[state].tone;
  }
});

describe('presentCondition', () => {
  const expectations: Record<InvalidationConditionStateWire, Presented> = {
    breached: { word: 'breached', tone: 'stop' },
    not_breached: { word: 'holds', tone: 'done' },
    unevaluable: { word: 'unevaluable', tone: 'wait' },
  };

  it('pairs word and tone for every condition state', () => {
    for (const [state, expected] of Object.entries(expectations)) {
      expect(presentCondition(state as InvalidationConditionStateWire)).toEqual(expected);
    }
  });
});

describe('presentCriticVerdict', () => {
  const expectations: Record<NonNullable<RiskCriticRow['critic_verdict']>, Presented> = {
    pass: { word: 'pass', tone: 'done' },
    trim: { word: 'trim', tone: 'live' },
    reject: { word: 'reject', tone: 'stop' },
    unavailable: { word: 'unavailable', tone: 'wait' },
  };

  it('pairs word and tone for every recorded verdict', () => {
    for (const [verdict, expected] of Object.entries(expectations)) {
      expect(presentCriticVerdict(verdict as RiskCriticRow['critic_verdict'])).toEqual(expected);
    }
  });

  it('presents a null verdict as "no verdict", waiting like an unevaluable condition', () => {
    expect(presentCriticVerdict(null)).toEqual({ word: 'no verdict', tone: 'wait' });
  });
});

describe('presentCloseReason', () => {
  const expectations: Record<CloseReason, Presented> = {
    stop: { word: 'stop hit', tone: 'stop' },
    target: { word: 'target hit', tone: 'done' },
    exit: { word: 'exit', tone: 'skip' },
    flatten: { word: 'flattened', tone: 'skip' },
    signal_decay: { word: 'signal decay', tone: 'skip' },
    direction_flip: { word: 'direction flip', tone: 'skip' },
  };

  it('pairs word and tone for every close reason', () => {
    for (const [reason, expected] of Object.entries(expectations)) {
      expect(presentCloseReason(reason as CloseReason)).toEqual(expected);
    }
  });
});
