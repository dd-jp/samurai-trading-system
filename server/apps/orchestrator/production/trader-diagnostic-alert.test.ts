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

/** The alerting subset — what `observe` used to return before #710's review. */
function alerting(observed: readonly ObservedTraderDiagnostic[]): ObservedTraderDiagnostic[] {
  return observed.filter((entry) => entry.alert);
}

describe('TraderDiagnosticThrottle', () => {
  it('alerts on the first occurrence', () => {
    // Unlike the analyst-skip channel's threshold of two: every kind here is
    // something that should never happen at all, so waiting for a second buys
    // nothing but a later alert.
    const throttle = new TraderDiagnosticThrottle();

    const due = alerting(throttle.observe('SPY', [diagnostic()]));

    expect(due).toHaveLength(1);
    expect(due[0]?.consecutive_ticks).toBe(1);
  });

  it('reports every observation, not only the alerting ones', () => {
    // #710. The caller's `error` log is driven by this return value, so an
    // entry omitted here is a tick with no durable record of a condition that
    // was still present. Ticks 2..8 of a persisting fault used to return
    // nothing at all, which is what made the log go quiet between alerts while
    // the module docblock promised it never did.
    const throttle = new TraderDiagnosticThrottle();

    throttle.observe('SPY', [diagnostic()]);
    const second = throttle.observe('SPY', [diagnostic()]);

    expect(second).toHaveLength(1);
    expect(second[0]?.consecutive_ticks).toBe(2);
    // Observed and counted, but NOT escalated — the log fires, the chat does not.
    expect(second[0]?.alert).toBe(false);
  });

  it('counts a kind repeated within one tick ONCE', () => {
    // #710. `routeDecision` evaluates `withinFlattenWindow` for the held
    // position and then hands the same `diagnostics` array to `buildBracket`,
    // which evaluates it again — so one tick can present the same kind twice.
    // Counting observations rather than ticks made `consecutive_ticks` climb by
    // two per tick: the alert text would tell the operator "4 consecutive
    // ticks" after two, and the bounded repeat would fire at twice its
    // interval.
    const throttle = new TraderDiagnosticThrottle();

    const first = throttle.observe('SPY', [
      diagnostic({ detail: 'noticed on the held position' }),
      diagnostic({ detail: 'noticed again while sizing the scale-in' }),
    ]);

    expect(first).toHaveLength(1);
    expect(first[0]?.consecutive_ticks).toBe(1);
    // The position-level view wins, since it is the one that describes the book.
    expect(first[0]?.diagnostic.detail).toBe('noticed on the held position');

    // And the run advances by one tick, not two.
    const second = throttle.observe('SPY', [diagnostic(), diagnostic()]);
    expect(second[0]?.consecutive_ticks).toBe(2);
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
      if (alerting(throttle.observe('SPY', [diagnostic()])).length > 0) alertedOn.push(tick);
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

  it('returns nothing at all on a clean tick', () => {
    // The caller logs one `error` line per returned entry, so a phantom entry
    // here would be an error in the log for a tick that had none.
    const throttle = new TraderDiagnosticThrottle();

    throttle.observe('SPY', [diagnostic()]);

    expect(throttle.observe('SPY', [])).toEqual([]);
  });

  it('counts each KIND separately, so one condition cannot consume or reset another', () => {
    // ADR-0008 §1 had to make exactly this correction for the spend cap's latch:
    // under a single per-instrument counter, a transient fault fires, sets the
    // counter and recovers — and the permanent condition that appears later is
    // counted as a continuation of a run it has nothing to do with.
    const throttle = new TraderDiagnosticThrottle();

    throttle.observe('SPY', [diagnostic({ kind: 'session_end_absent_on_non_crypto' })]);
    // The first kind clears; a different one appears. It must alert on its own
    // first occurrence rather than inheriting the other's run.
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
    // The orchestrator runs instruments sequentially through one step closure
    // (`maxConcurrentInstruments: 1`), so every instrument's ticks interleave in
    // this single counter. A clear scoped to the wrong key would mean SPY's
    // healthy tick silently resetting BTC-USD's still-broken calendar, and the
    // repeat alert would then never fire.
    const throttle = new TraderDiagnosticThrottle();

    throttle.observe('BTC-USD', [diagnostic({ asset_class: 'crypto' })]);
    throttle.observe('SPY', []);
    const due = alerting(throttle.observe('BTC-USD', [diagnostic({ asset_class: 'crypto' })]));

    // Second consecutive tick for BTC-USD: counted, and correctly NOT alerting
    // again this soon.
    expect(due).toHaveLength(0);
  });
});
