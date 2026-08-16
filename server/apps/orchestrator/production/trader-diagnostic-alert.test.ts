/**
 * #698 — the diagnostic alert throttle.
 *
 * Tested on its own rather than only through `buildTraderStep` because the
 * failure modes here are about SEQUENCES of ticks, and reproducing a 40-tick
 * sequence through the full step would test the fixture rather than the rule.
 */
import { describe, expect, it } from 'vitest';
import type { TraderDiagnostic } from '../../../pipeline/trader/index.js';
import {
  ALERT_REPEAT_EVERY_DIAGNOSTICS,
  TraderDiagnosticThrottle,
} from './trader-diagnostic-alert.js';

function diagnostic(overrides: Partial<TraderDiagnostic> = {}): TraderDiagnostic {
  return {
    kind: 'session_end_in_past',
    asset_class: 'stocks',
    detail: 'the calendar resolved a close in the past',
    ...overrides,
  };
}

describe('TraderDiagnosticThrottle', () => {
  it('alerts on the first occurrence', () => {
    // Unlike the analyst-skip channel's threshold of two: every kind here is
    // something that should never happen at all, so waiting for a second buys
    // nothing but a later alert.
    const throttle = new TraderDiagnosticThrottle();

    const due = throttle.observe('SPY', [diagnostic()]);

    expect(due).toHaveLength(1);
    expect(due[0]?.consecutive_ticks).toBe(1);
  });

  it('stays quiet while the condition persists, then repeats on a bounded interval', () => {
    // The flood this prevents is not hypothetical:
    // `session_end_absent_on_non_crypto` fires EVERY tick for an affected
    // instrument, which at ADR-0008's 15-minute cadence is ~96 messages per
    // instrument per day into the chat that also carries kill-threshold
    // breaches.
    const throttle = new TraderDiagnosticThrottle();
    const alertedOn: number[] = [];

    for (let tick = 1; tick <= 20; tick += 1) {
      if (throttle.observe('SPY', [diagnostic()]).length > 0) alertedOn.push(tick);
    }

    // First, then every 8th thereafter — frequent enough to be noticed, rare
    // enough to stay readable.
    expect(alertedOn).toEqual([
      1,
      1 + ALERT_REPEAT_EVERY_DIAGNOSTICS,
      1 + 2 * ALERT_REPEAT_EVERY_DIAGNOSTICS,
    ]);
  });

  it('resets the run once the condition clears, so an intermittent fault cannot accumulate', () => {
    // Without this, a condition that appears once a day for eight days would
    // reach the repeat threshold and report "8 consecutive ticks" — a sentence
    // that would be false, and would misdirect whoever read it.
    const throttle = new TraderDiagnosticThrottle();

    throttle.observe('SPY', [diagnostic()]);
    throttle.observe('SPY', [diagnostic()]);
    throttle.observe('SPY', []);
    const due = throttle.observe('SPY', [diagnostic()]);

    expect(due[0]?.consecutive_ticks).toBe(1);
  });

  it('counts each KIND separately, so one condition cannot consume or reset another', () => {
    // ADR-0008 §1 had to make exactly this correction for the spend cap's latch:
    // under a single per-instrument counter, a transient fault fires, sets the
    // counter and recovers — and the permanent condition that appears later is
    // counted as a continuation of a run it has nothing to do with.
    const throttle = new TraderDiagnosticThrottle();

    throttle.observe('SPY', [diagnostic({ kind: 'session_end_in_past' })]);
    // The first kind clears; a different one appears. It must alert on its own
    // first occurrence rather than inheriting the other's run.
    const due = throttle.observe('SPY', [diagnostic({ kind: 'atr_not_finite' })]);

    expect(due).toHaveLength(1);
    expect(due[0]?.diagnostic.kind).toBe('atr_not_finite');
    expect(due[0]?.consecutive_ticks).toBe(1);
  });

  it('reports both kinds when both are present on one tick', () => {
    const throttle = new TraderDiagnosticThrottle();

    const due = throttle.observe('SPY', [
      diagnostic({ kind: 'session_end_in_past' }),
      diagnostic({ kind: 'atr_not_finite' }),
    ]);

    expect(due.map((entry) => entry.diagnostic.kind).sort()).toEqual([
      'atr_not_finite',
      'session_end_in_past',
    ]);
  });

  it('keeps instruments independent — a quiet tick on one does not clear another', () => {
    // The orchestrator runs instruments sequentially through one step closure
    // (`maxConcurrentInstruments: 1`), so every instrument's ticks interleave in
    // this single counter. A clear scoped to the wrong key would mean SPY's
    // healthy tick silently resetting BTC-USD's still-broken calendar, and the
    // repeat alert would then never fire.
    const throttle = new TraderDiagnosticThrottle();

    throttle.observe('BTC-USD', [diagnostic({ asset_class: 'crypto' })]);
    throttle.observe('SPY', []);
    const due = throttle.observe('BTC-USD', [diagnostic({ asset_class: 'crypto' })]);

    // Second consecutive tick for BTC-USD: counted, and correctly NOT alerting
    // again this soon.
    expect(due).toHaveLength(0);
  });
});
