/**
 * #1128 review round 1 — the write-gate math extracted out of
 * `direct-bind.ts`'s `exitCheck` closure, pinned directly rather than only
 * through `direct-bind.test.ts`'s full-pipeline tests (same reasoning as
 * `filled-zero-size-throttle.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { ExitSkipWriteThrottle } from './exit-skip-write-throttle.js';
import { ALERT_REPEAT_EVERY_DIAGNOSTICS } from './trader-diagnostic-alert.js';

describe('ExitSkipWriteThrottle', () => {
  it('writes on the very first observation of an ordinary (non-bounded-repeat) reason', () => {
    const throttle = new ExitSkipWriteThrottle();
    expect(throttle.shouldWrite('AAA', 'below_conviction_floor')).toBe(true);
  });

  it('stays silent on an unchanged, ordinary reason repeated every tick', () => {
    const throttle = new ExitSkipWriteThrottle();
    expect(throttle.shouldWrite('AAA', 'below_conviction_floor')).toBe(true);
    throttle.record('AAA', 'below_conviction_floor', true);

    for (let i = 0; i < ALERT_REPEAT_EVERY_DIAGNOSTICS + 5; i += 1) {
      expect(throttle.shouldWrite('AAA', 'below_conviction_floor')).toBe(false);
      throttle.record('AAA', 'below_conviction_floor', false);
    }
  });

  it('writes again immediately on a single genuine change — not gated by the repeat budget', () => {
    const throttle = new ExitSkipWriteThrottle();
    throttle.shouldWrite('AAA', 'below_conviction_floor');
    throttle.record('AAA', 'below_conviction_floor', true);

    expect(throttle.shouldWrite('AAA', 'exit_no_filled_size')).toBe(true);
  });

  it('exit_no_filled_size writes once on onset, then stays silent while unchanged (FilledZeroSizeThrottle already covers repeats)', () => {
    const throttle = new ExitSkipWriteThrottle();
    expect(throttle.shouldWrite('AAA', 'exit_no_filled_size')).toBe(true);
    throttle.record('AAA', 'exit_no_filled_size', true);

    for (let i = 0; i < ALERT_REPEAT_EVERY_DIAGNOSTICS + 2; i += 1) {
      expect(throttle.shouldWrite('AAA', 'exit_no_filled_size')).toBe(false);
      throttle.record('AAA', 'exit_no_filled_size', false);
    }
  });

  it('exit_held_quantity_diverged repeats on the bounded cadence while the wedge persists, unchanged', () => {
    const throttle = new ExitSkipWriteThrottle();
    const wrote: boolean[] = [];
    for (let i = 0; i < ALERT_REPEAT_EVERY_DIAGNOSTICS + 1; i += 1) {
      const shouldWrite = throttle.shouldWrite('AAA', 'exit_held_quantity_diverged');
      wrote.push(shouldWrite);
      throttle.record('AAA', 'exit_held_quantity_diverged', shouldWrite);
    }
    // Onset (tick 0) writes; ticks 1..ALERT_REPEAT_EVERY_DIAGNOSTICS-1 stay
    // quiet; tick ALERT_REPEAT_EVERY_DIAGNOSTICS writes again — the budget
    // is the sole gate for a reason that never stops being "the same as last
    // tick," so this is pinned directly against the constant, not a literal.
    const expected = Array.from(
      { length: ALERT_REPEAT_EVERY_DIAGNOSTICS + 1 },
      (_, i) => i === 0 || i === ALERT_REPEAT_EVERY_DIAGNOSTICS,
    );
    expect(wrote).toEqual(expected);
  });

  it('bounds a period-1 (every tick) flapping sequence to two writes per repeat-budget window', () => {
    const throttle = new ExitSkipWriteThrottle();
    const reasons = ['below_conviction_floor', 'below_min_notional'] as const;
    const ticks = 2 * ALERT_REPEAT_EVERY_DIAGNOSTICS + 4;
    const wrote: boolean[] = [];
    for (let tick = 0; tick < ticks; tick += 1) {
      const reason = reasons[tick % 2] as (typeof reasons)[number];
      const shouldWrite = throttle.shouldWrite('AAA', reason);
      wrote.push(shouldWrite);
      throttle.record('AAA', reason, shouldWrite);
    }
    // Each reason gets its OWN per-reason repeat budget (see the class doc):
    // reason A last written at tick 0 is eligible again once
    // ALERT_REPEAT_EVERY_DIAGNOSTICS ticks have passed for A specifically,
    // independent of how many B-ticks happened in between. Under period-1
    // alternation, A occupies the even indices and B the odd ones, so both
    // budgets clear on the same two-tick pair every
    // ALERT_REPEAT_EVERY_DIAGNOSTICS ticks: indices 0,1 (onset), then
    // ALERT_REPEAT_EVERY_DIAGNOSTICS, ALERT_REPEAT_EVERY_DIAGNOSTICS + 1,
    // and so on.
    const expected = wrote.map((_, i) => i % ALERT_REPEAT_EVERY_DIAGNOSTICS <= 1);
    expect(wrote).toEqual(expected);
  });

  it('bounds a dwell-2 (holds each reason two ticks) oscillation the same way a naive change detector would miss', () => {
    // The gap this closes: an earlier version of this throttle counted
    // consecutive tick-over-tick CHANGES to detect flapping, which resets to
    // 0 every time a reason repeats the tick right before it — so any dwell
    // of 2+ ticks per reason never accumulated a streak and wrote on every
    // single switch, unbounded (e.g. an intermittent InsufficientBarsError
    // producing A,A,B,B,A,A,...). The per-reason budget here bounds it
    // regardless of dwell length.
    const throttle = new ExitSkipWriteThrottle();
    const reasons = ['below_conviction_floor', 'below_min_notional'] as const;
    const ticks = 2 * ALERT_REPEAT_EVERY_DIAGNOSTICS + 4;
    const wrote: boolean[] = [];
    for (let tick = 0; tick < ticks; tick += 1) {
      const reason = reasons[Math.floor(tick / 2) % 2] as (typeof reasons)[number];
      const shouldWrite = throttle.shouldWrite('AAA', reason);
      wrote.push(shouldWrite);
      throttle.record('AAA', reason, shouldWrite);
    }
    // Onset writes reason A (index 0); reason B's own onset writes at index
    // 2 (its first appearance); both budgets clear
    // ALERT_REPEAT_EVERY_DIAGNOSTICS ticks after THEIR OWN last write, so
    // the next writes land at index ALERT_REPEAT_EVERY_DIAGNOSTICS (A) and
    // ALERT_REPEAT_EVERY_DIAGNOSTICS + 2 (B), and so on — every switch is
    // NOT a write, unlike the unbounded naive design this replaced.
    const expected = wrote.map((_, i) => {
      const r = i % ALERT_REPEAT_EVERY_DIAGNOSTICS;
      return r === 0 || r === 2;
    });
    expect(wrote).toEqual(expected);
    // The decisive bound: at most 2 writes per repeat-budget window, not one
    // per switch (which would be ~ticks/2 for this dwell).
    expect(wrote.filter(Boolean).length).toBeLessThanOrEqual(
      2 * Math.ceil(ticks / ALERT_REPEAT_EVERY_DIAGNOSTICS),
    );
    expect(wrote.filter(Boolean).length).toBeLessThan(ticks / 2);
  });

  it('a cleared episode forgets history — a reopened lot with the same first reason writes again immediately', () => {
    const throttle = new ExitSkipWriteThrottle();
    expect(throttle.shouldWrite('AAA', 'below_conviction_floor')).toBe(true);
    throttle.record('AAA', 'below_conviction_floor', true);
    expect(throttle.shouldWrite('AAA', 'below_conviction_floor')).toBe(false);

    throttle.clearEpisode('AAA');

    expect(throttle.shouldWrite('AAA', 'below_conviction_floor')).toBe(true);
  });

  it('tracks each instrument independently', () => {
    const throttle = new ExitSkipWriteThrottle();
    throttle.shouldWrite('AAA', 'below_conviction_floor');
    throttle.record('AAA', 'below_conviction_floor', true);

    expect(throttle.shouldWrite('BBB', 'below_conviction_floor')).toBe(true);
  });
});
