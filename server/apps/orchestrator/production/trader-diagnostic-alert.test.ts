import { describe, expect, it } from 'vitest';
import type { TraderDiagnostic } from '../../../pipeline/trader/index.js';
import {
  ALERT_REPEAT_EVERY_DIAGNOSTICS,
  type ObservedTraderDiagnostic,
  TraderDiagnosticThrottle,
} from './trader-diagnostic-alert.js';

function diagnostic(overrides: Partial<TraderDiagnostic> = {}): TraderDiagnostic {
  return {
    kind: 'session_end_absent_on_non_crypto',
    asset_class: 'stocks',
    detail: 'the calendar resolved no session end',
    ...overrides,
  };
}

function alerting(observed: readonly ObservedTraderDiagnostic[]): ObservedTraderDiagnostic[] {
  return observed.filter((entry) => entry.alert);
}

describe('TraderDiagnosticThrottle', () => {
  it('alerts on the first occurrence', () => {
    const throttle = new TraderDiagnosticThrottle();

    const due = alerting(throttle.observe('SPY', [diagnostic()]));

    expect(due).toHaveLength(1);
    expect(due[0]?.consecutive_ticks).toBe(1);
  });

  it('reports every observation, not only the alerting ones', () => {
    const throttle = new TraderDiagnosticThrottle();

    throttle.observe('SPY', [diagnostic()]);
    const second = throttle.observe('SPY', [diagnostic()]);

    expect(second).toHaveLength(1);
    expect(second[0]?.consecutive_ticks).toBe(2);
    expect(second[0]?.alert).toBe(false);
  });

  it('counts a kind repeated within one tick ONCE', () => {
    const throttle = new TraderDiagnosticThrottle();

    const first = throttle.observe('SPY', [
      diagnostic({ detail: 'noticed on the held position' }),
      diagnostic({ detail: 'noticed again while sizing the scale-in' }),
    ]);

    expect(first).toHaveLength(1);
    expect(first[0]?.consecutive_ticks).toBe(1);
    expect(first[0]?.diagnostic.detail).toBe('noticed on the held position');

    const second = throttle.observe('SPY', [diagnostic(), diagnostic()]);
    expect(second[0]?.consecutive_ticks).toBe(2);
  });

  it('stays quiet while the condition persists, then repeats on a bounded interval', () => {
    const throttle = new TraderDiagnosticThrottle();
    const alertedOn: number[] = [];

    for (let tick = 1; tick <= 20; tick += 1) {
      if (alerting(throttle.observe('SPY', [diagnostic()])).length > 0) alertedOn.push(tick);
    }

    expect(alertedOn).toEqual([
      1,
      1 + ALERT_REPEAT_EVERY_DIAGNOSTICS,
      1 + 2 * ALERT_REPEAT_EVERY_DIAGNOSTICS,
    ]);
  });

  it('resets the run once the condition clears, so an intermittent fault cannot accumulate', () => {
    const throttle = new TraderDiagnosticThrottle();

    throttle.observe('SPY', [diagnostic()]);
    throttle.observe('SPY', [diagnostic()]);
    throttle.observe('SPY', []);
    const due = throttle.observe('SPY', [diagnostic()]);

    expect(due[0]?.consecutive_ticks).toBe(1);
  });

  it('returns nothing at all on a clean tick', () => {
    const throttle = new TraderDiagnosticThrottle();

    throttle.observe('SPY', [diagnostic()]);

    expect(throttle.observe('SPY', [])).toEqual([]);
  });

  it('counts each KIND separately, so one condition cannot consume or reset another', () => {
    const throttle = new TraderDiagnosticThrottle();

    throttle.observe('SPY', [diagnostic({ kind: 'session_end_absent_on_non_crypto' })]);
    const due = alerting(throttle.observe('SPY', [diagnostic({ kind: 'atr_not_finite' })]));

    expect(due).toHaveLength(1);
    expect(due[0]?.diagnostic.kind).toBe('atr_not_finite');
    expect(due[0]?.consecutive_ticks).toBe(1);
  });

  it('reports both kinds when both are present on one tick', () => {
    const throttle = new TraderDiagnosticThrottle();

    const due = throttle.observe('SPY', [
      diagnostic({ kind: 'session_end_absent_on_non_crypto' }),
      diagnostic({ kind: 'atr_not_finite' }),
    ]);

    expect(due.map((entry) => entry.diagnostic.kind).sort()).toEqual([
      'atr_not_finite',
      'session_end_absent_on_non_crypto',
    ]);
  });

  it('keeps instruments independent — a quiet tick on one does not clear another', () => {
    const throttle = new TraderDiagnosticThrottle();

    throttle.observe('BTC-USD', [diagnostic({ asset_class: 'crypto' })]);
    throttle.observe('SPY', []);
    const due = alerting(throttle.observe('BTC-USD', [diagnostic({ asset_class: 'crypto' })]));

    expect(due).toHaveLength(0);
  });
});
