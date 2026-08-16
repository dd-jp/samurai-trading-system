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
    // window only when its phase happens to fall there.
    //
    // That phase is fixed at boot, not re-rolled per session: ticks land at
    // `bootTime + k * tickIntervalMs`, and a close recurs every 24h, which is an
    // exact multiple of 15 minutes. So this is not an intermittent miss — the
    // run either flattens every session or never flattens once, decided by when
    // the process started, with nothing logged either way.
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
    // whole tick when the previous is still running, and the timer drifts. Two
    // buys tolerance for one arbitrary lost tick — not a general safety factor,
    // since #669's drops are correlated (see the constant's docblock).
    const tick = 5 * MINUTE;
    expect(() => assertFlattenWindowCoversTickInterval(configWithWindow(tick), tick)).toThrow(
      /only 1\.00 tick\(s\) fit/,
    );
  });

  it('rejects a zero tick interval instead of passing it vacuously (#711 review)', () => {
    // `config.tickIntervalMs ?? DEFAULT` substitutes only for null/undefined, so
    // a configured 0 reaches here intact. Without the guard `required` is 0 and
    // EVERY window clears it — the assertion would approve a config that
    // disables flat-by-close, which is worse than not asserting at all.
    expect(() => assertFlattenWindowCoversTickInterval(configWithWindow(5 * MINUTE), 0)).toThrow(
      /must be a positive, finite number/,
    );
  });

  it('rejects a non-finite tick interval', () => {
    expect(() =>
      assertFlattenWindowCoversTickInterval(configWithWindow(5 * MINUTE), Number.NaN),
    ).toThrow(/must be a positive, finite number/);
    expect(() =>
      assertFlattenWindowCoversTickInterval(configWithWindow(5 * MINUTE), Number.POSITIVE_INFINITY),
    ).toThrow(/must be a positive, finite number/);
  });

  it('rejects a negative tick interval', () => {
    expect(() => assertFlattenWindowCoversTickInterval(configWithWindow(5 * MINUTE), -1)).toThrow(
      /must be a positive, finite number/,
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
