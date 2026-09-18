import {
  DEGRADED_DECISIONS,
  isDegradedDecision,
  isQuorumSkipDecision,
} from '../../../contracts/index.js';
import type { AnalystFailure } from '../../pipeline/analysts/index.js';
import { AnalystSkipKindRelay, analystsSkipDecisionWord, skipKindOf } from './analysts-decision.js';
import { CONTROL_TRACE_SUFFIX } from './control-arm.js';

function failure(overrides: Partial<AnalystFailure> = {}): AnalystFailure {
  return {
    analyst_type: 'technical',
    role: 'mandatory',
    reason: 'technical did not answer within 10000ms (after 2 attempts)',
    kind: 'timeout',
    ...overrides,
  };
}

describe('skipKindOf', () => {
  it('reports nothing for a run that was not skipped', () => {
    expect(skipKindOf(false, [failure({ role: 'optional', kind: 'other' })])).toBeUndefined();
  });

  it('reads the kind off the mandatory failure that caused the skip', () => {
    expect(skipKindOf(true, [failure()])).toBe('timeout');
    expect(skipKindOf(true, [failure({ kind: 'other' })])).toBe('fault');
  });

  it('folds every non-timeout cause to the same audit word (#1394)', () => {
    for (const kind of [
      'refusal',
      'truncated',
      'unparseable',
      'rate_limited',
      'cancelled',
      'transport',
      'other',
    ] as const) {
      expect(skipKindOf(true, [failure({ kind })])).toBe('fault');
    }
    expect(skipKindOf(true, [failure({ kind: 'timeout' })])).toBe('timeout');
  });

  it('ignores an optional persona entirely', () => {
    expect(skipKindOf(true, [failure({ role: 'optional' }), failure({ kind: 'other' })])).toBe(
      'fault',
    );
  });

  it('reports a timeout when mandatory failures are mixed', () => {
    expect(
      skipKindOf(true, [failure({ analyst_type: 'fundamental', kind: 'other' }), failure()]),
    ).toBe('timeout');
  });

  it('reports a fault when a skip carries no mandatory failure at all', () => {
    expect(skipKindOf(true, [])).toBe('fault');
  });
});

describe('analystsSkipDecisionWord', () => {
  it('names the cause when one was relayed', () => {
    expect(analystsSkipDecisionWord('timeout')).toBe('quorum_skip_timeout');
    expect(analystsSkipDecisionWord('fault')).toBe('quorum_skip_fault');
  });

  it('falls back to the undifferentiated word when nothing was relayed', () => {
    expect(analystsSkipDecisionWord(undefined)).toBe('quorum_skip');
  });

  it('emits only words the dashboard already classifies as a quorum skip', () => {
    for (const kind of ['timeout', 'fault', undefined] as const) {
      expect(isQuorumSkipDecision(analystsSkipDecisionWord(kind))).toBe(true);
    }
  });

  it('marks both named causes degraded, and leaves the plain word alone', () => {
    expect(isDegradedDecision(analystsSkipDecisionWord('timeout'))).toBe(true);
    expect(isDegradedDecision(analystsSkipDecisionWord('fault'))).toBe(true);
    expect(isDegradedDecision(analystsSkipDecisionWord(undefined))).toBe(false);
    expect(DEGRADED_DECISIONS.quorum_skip_timeout).toContain('budget firing');
  });
});

describe('AnalystSkipKindRelay', () => {
  it('hands each pass its own kind', () => {
    const relay = new AnalystSkipKindRelay();
    relay.set('trace-a', 'timeout');
    relay.set('trace-b', 'fault');

    expect(relay.take('trace-b')).toBe('fault');
    expect(relay.take('trace-a')).toBe('timeout');
  });

  it('reports nothing for a pass that recorded nothing', () => {
    expect(new AnalystSkipKindRelay().take('trace-a')).toBeUndefined();
  });

  it('deletes on read, so a later pass cannot inherit an earlier skip', () => {
    const relay = new AnalystSkipKindRelay();
    relay.set('trace-a', 'timeout');

    expect(relay.take('trace-a')).toBe('timeout');
    expect(relay.take('trace-a')).toBeUndefined();
  });

  it('cannot let the control pass reach the live pass it shadows (#1080)', () => {
    const relay = new AnalystSkipKindRelay();
    relay.set('trace-1', 'timeout');

    expect(relay.take(`trace-1${CONTROL_TRACE_SUFFIX}`)).toBeUndefined();
    expect(relay.take('trace-1')).toBe('timeout');
  });

  it('bounds itself when the writer is wired and the reader is not', () => {
    const relay = new AnalystSkipKindRelay();
    for (let i = 0; i < 200; i++) {
      relay.set(`trace-${i}`, 'timeout');
    }

    expect(relay.take('trace-0')).toBeUndefined();
    expect(relay.take('trace-199')).toBe('timeout');
  });
});
