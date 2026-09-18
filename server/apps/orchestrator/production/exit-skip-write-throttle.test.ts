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
    const expected = Array.from(
      { length: ALERT_REPEAT_EVERY_DIAGNOSTICS + 1 },
      (_, i) => i === 0 || i === ALERT_REPEAT_EVERY_DIAGNOSTICS,
    );
    expect(wrote).toEqual(expected);
  });

  it('bounds a period-1 (every tick) flapping sequence between two reasons to two writes per repeat-budget window', () => {
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
    const expected = wrote.map((_, i) => i % ALERT_REPEAT_EVERY_DIAGNOSTICS <= 1);
    expect(wrote).toEqual(expected);
  });

  it('bounds an N-reason period-1 cycle to N writes per repeat-budget window, not a fixed two (review round 3, finding 1)', () => {
    const throttle = new ExitSkipWriteThrottle();
    const reasons = [
      'neutral_direction_while_flat',
      'below_conviction_floor',
      'session_closing',
      'below_min_notional',
    ] as const;
    const ticks = 3 * ALERT_REPEAT_EVERY_DIAGNOSTICS;
    const wrote: boolean[] = [];
    for (let tick = 0; tick < ticks; tick += 1) {
      const reason = reasons[tick % reasons.length] as (typeof reasons)[number];
      const shouldWrite = throttle.shouldWrite('AAA', reason);
      wrote.push(shouldWrite);
      throttle.record('AAA', reason, shouldWrite);
    }
    const expected = wrote.map((_, i) => i % ALERT_REPEAT_EVERY_DIAGNOSTICS < reasons.length);
    expect(wrote).toEqual(expected);
    expect(wrote.filter(Boolean).length).toBe(
      reasons.length * Math.ceil(ticks / ALERT_REPEAT_EVERY_DIAGNOSTICS),
    );
    expect(wrote.filter(Boolean).length).toBeGreaterThan(2);
  });

  it('bounds a dwell-2 (holds each reason two ticks) oscillation between two reasons the same way a naive change detector would miss', () => {
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
    const expected = wrote.map((_, i) => {
      const r = i % ALERT_REPEAT_EVERY_DIAGNOSTICS;
      return r === 0 || r === 2;
    });
    expect(wrote).toEqual(expected);
    expect(wrote.filter(Boolean).length).toBeLessThanOrEqual(
      reasons.length * Math.ceil(ticks / ALERT_REPEAT_EVERY_DIAGNOSTICS),
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
