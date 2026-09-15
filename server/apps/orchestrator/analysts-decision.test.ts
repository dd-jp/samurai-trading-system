/**
 * #1080. The cases here are the two halves of the seam: reading a cause off a
 * run's failures, and turning it into a word an operator and the dashboard can
 * both act on. The relay's own cases are about a kind belonging to exactly one
 * pass — a stale one would mislabel a later tick, which is the confusion this
 * whole mechanism exists to remove.
 */
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
    // An optional persona can fail on a run that produced views. Reading a
    // kind off that run would label a healthy tick with a failure
    expect(skipKindOf(false, [failure({ role: 'optional', kind: 'other' })])).toBeUndefined();
  });

  it('reads the kind off the mandatory failure that caused the skip', () => {
    expect(skipKindOf(true, [failure()])).toBe('timeout');
    expect(skipKindOf(true, [failure({ kind: 'other' })])).toBe('fault');
  });

  it('folds every non-timeout cause to the same audit word (#1394)', () => {
    // The taxonomy widened the KIND, not this decision: `quorum_skip_fault`
    // and `quorum_skip_timeout` are the two words the audit log carries, and a
    // new cause must not silently become a third
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
    // The optional timeout did not skip anything — the mandatory fault did
    expect(skipKindOf(true, [failure({ role: 'optional' }), failure({ kind: 'other' })])).toBe(
      'fault',
    );
  });

  it('reports a timeout when mandatory failures are mixed', () => {
    // The condition #1080 is about must not be hidden by a second mandatory
    // persona failing for an unrelated reason on the same pass
    expect(
      skipKindOf(true, [failure({ analyst_type: 'fundamental', kind: 'other' }), failure()]),
    ).toBe('timeout');
  });

  it('reports a fault when a skip carries no mandatory failure at all', () => {
    // Not reachable through `AnalystOrchestrator` (only a mandatory failure
    // sets `skipped`), and deliberately not thrown on: a caller that skipped
    // for a reason this module cannot see is still a stage that produced no
    // views, and `fault` is the word that says so without claiming a budget
    // fired
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
    // The lane outcome is derived from this word (service-api's `outcomeOf`)
    // A word missing from that set silently re-classifies a skipped lane as
    // `stopped`, which is why the set lives in `contracts/`
    for (const kind of ['timeout', 'fault', undefined] as const) {
      expect(isQuorumSkipDecision(analystsSkipDecisionWord(kind))).toBe(true);
    }
  });

  it('marks both named causes degraded, and leaves the plain word alone', () => {
    // `isDegradedDecision` is what lifts the runner's log line to `warn` and
    // what the drawer glosses from. The plain word stays `info`: the control
    // arm and the backtest reach it without any failure having occurred
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

  /**
   * The live arm's kind must not be reachable from the control pass that
   * shadows it. `take` is destructive, so a key shared across the two arms
   * would let whichever ran first consume the kind and leave the other
   * recording an undifferentiated `quorum_skip` — the exact silent degradation
   * #1080 exists to remove, reintroduced one arm over.
   *
   * The separation is structural rather than conventional: a control pass runs
   * under a suffixed trace, and nothing writes a kind under that key.
   */
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

    // The oldest are gone rather than retained for the life of the process,
    // and the newest are intact
    expect(relay.take('trace-0')).toBeUndefined();
    expect(relay.take('trace-199')).toBe('timeout');
  });
});
