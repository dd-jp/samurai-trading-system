/**
 * #670 — the tick-interval/flatten-window coupling.
 *
 * Tested on the assertion directly rather than only through
 * `buildProductionComponents`, because the property is arithmetic about two
 * numbers and reproducing it through a full component build would test the
 * fixture instead of the rule.
 */
import { describe, expect, it } from 'vitest';
import type { TraderConfig } from '../../../pipeline/trader/index.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import {
  assertFlattenWindowCoversTickInterval,
  MIN_TICKS_INSIDE_FLATTEN_WINDOW,
} from './flatten-tick-coupling.js';

const MINUTE = 60_000;

function configWithWindow(flattenBeforeCloseMs: number): TraderConfig {
  return { ...DEFAULT_TRADER_CONFIG, flatten_before_close_ms: flattenBeforeCloseMs };
}

describe('assertFlattenWindowCoversTickInterval', () => {
  it('rejects the exact configuration the paper profile shipped', () => {
    // The regression this ticket exists for, pinned to its real numbers: a
    // 5-minute flatten window against a 15-minute tick. The window is not a
    // duration during which the book flattens, it is a set of instants at which
    // flattening is POSSIBLE — so a 15-minute stride lands inside a 5-minute
    // window only when its phase happens to fall there, roughly one session in
    // three, and the other two carry overnight with nothing logged.
    expect(() =>
      assertFlattenWindowCoversTickInterval(configWithWindow(5 * MINUTE), 15 * MINUTE),
    ).toThrow(/flatten_before_close_ms/);
  });

  it('names both numbers and how many ticks actually fit, not just that it failed', () => {
    // A boot failure that says only "misconfigured" makes the next person
    // re-derive the arithmetic this ticket already did.
    expect(() =>
      assertFlattenWindowCoversTickInterval(configWithWindow(5 * MINUTE), 15 * MINUTE),
    ).toThrow(/only 0\.33 tick\(s\) fit/);
  });

  it('accepts a window that fits the required number of ticks exactly', () => {
    // The boundary is inclusive: at exactly N intervals the guarantee holds, and
    // rejecting it would force an arbitrary margin on top of a stated rule.
    const tick = 2 * MINUTE;
    expect(() =>
      assertFlattenWindowCoversTickInterval(
        configWithWindow(MIN_TICKS_INSIDE_FLATTEN_WINDOW * tick),
        tick,
      ),
    ).not.toThrow();
  });

  it('rejects a window one tick wide, which the bare arithmetic would allow', () => {
    // A half-open window of length W contains at least one tick when
    // W >= tickIntervalMs, so one interval is the arithmetic minimum — and it is
    // not enough. That single tick is not guaranteed to EXECUTE: #669 drops a
    // whole tick when the previous is still running, and a pass is ~13s against
    // a 30s crypto latency budget. The margin is the difference between a
    // flatten that survives losing a tick and one that does not.
    const tick = 5 * MINUTE;
    expect(() => assertFlattenWindowCoversTickInterval(configWithWindow(tick), tick)).toThrow(
      /only 1\.00 tick\(s\) fit/,
    );
  });

  it('accepts the default 60s tick against the default 5-minute window', () => {
    // `DEFAULT_TICK_INTERVAL_MS` is 60s, so every caller that never set an
    // interval was already safe — the defect was confined to the profile that
    // deliberately slowed the tick down for cost. Pinned so a future change to
    // either default cannot quietly reintroduce it.
    expect(() =>
      assertFlattenWindowCoversTickInterval(DEFAULT_TRADER_CONFIG, MINUTE),
    ).not.toThrow();
  });
});
