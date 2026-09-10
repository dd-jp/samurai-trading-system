/**
 * #670 — the tick-interval/flatten-window coupling.
 *
 * Tested on the assertion directly rather than only through
 * `buildProductionComponents`, because the property is arithmetic about two
 * numbers and reproducing it through a full component build would test the
 * fixture instead of the rule.
 */
import { describe, expect, it } from 'vitest';
import { UNRESOLVABLE_FLATTEN_MAX_AGE_MS } from '../../../pipeline/execution/index.js';
import type { TraderConfig } from '../../../pipeline/trader/index.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import {
  assertFlattenGraceWithinMarkAge,
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

  /**
   * #1389's grace is the same invariant one bell later: it too is a set of
   * instants at which flattening becomes possible, and a tick still has to land
   * in it. A grace no tick fits inside silently restores the forward-only
   * window this ticket removed.
   */
  describe('the post-close grace (#1389)', () => {
    // The pre-close window is widened out of the way: it is checked FIRST, so
    // leaving it at the default would make these cases fail on that bound
    // instead of the grace they are about.
    function configWithGrace(flattenAfterCloseMs: number): TraderConfig {
      return {
        ...DEFAULT_TRADER_CONFIG,
        flatten_before_close_ms: 60 * MINUTE,
        flatten_after_close_ms: flattenAfterCloseMs,
      };
    }

    it('rejects a grace shorter than one tick interval', () => {
      // A 2-minute grace at the paper profile's 15-minute cadence: no tick can
      // land in it, so the second chance #1389 exists to give does not exist.
      expect(() =>
        assertFlattenWindowCoversTickInterval(configWithGrace(2 * MINUTE), 15 * MINUTE),
      ).toThrow(/flatten_after_close_ms .* must be at least tickIntervalMs/);
    });

    it('accepts a grace of exactly one tick interval', () => {
      // ONE, not `MIN_TICKS_INSIDE_FLATTEN_WINDOW` — the grace is the backstop
      // to the pre-close window, not the path carrying the obligation, and
      // every extra minute is spent against gate 2a's ceiling.
      expect(() =>
        assertFlattenWindowCoversTickInterval(configWithGrace(MINUTE), MINUTE),
      ).not.toThrow();
    });

    it('checks the grace even when the pre-close window is generous', () => {
      // The two bounds are independent: a wide pre-close window says nothing
      // about whether a tick lands after the bell, and folding them into one
      // check would let a comfortable window vouch for a grace of zero.
      expect(() =>
        assertFlattenWindowCoversTickInterval(
          {
            ...DEFAULT_TRADER_CONFIG,
            flatten_before_close_ms: 60 * MINUTE,
            flatten_after_close_ms: 1,
          },
          MINUTE,
        ),
      ).toThrow(/flatten_after_close_ms/);
    });
  });
});

describe('assertFlattenGraceWithinMarkAge (#1389)', () => {
  const MAX_MARK_AGE_STOCKS = 15 * MINUTE;

  it('accepts the shipped 5-minute grace against the shipped 15-minute ceiling', () => {
    expect(() =>
      assertFlattenGraceWithinMarkAge(DEFAULT_TRADER_CONFIG, MAX_MARK_AGE_STOCKS),
    ).not.toThrow();
  });

  it('rejects a grace past the price gate that would refuse every tick in it', () => {
    // A priced mandatory flatten is exempt from gate 1 and gate 4, NOT from
    // gate 2a — so past `max_mark_age.stocks` the extra grace produces ticks
    // that can only ever be refused `stale_feed`, while `trader_log` reads like
    // a grace that is working.
    expect(() =>
      assertFlattenGraceWithinMarkAge(
        { ...DEFAULT_TRADER_CONFIG, flatten_after_close_ms: 20 * MINUTE },
        MAX_MARK_AGE_STOCKS,
      ),
    ).toThrow(/must not exceed verdictConfig.max_mark_age.stocks/);
  });

  it('accepts a grace exactly at the ceiling', () => {
    expect(() =>
      assertFlattenGraceWithinMarkAge(
        { ...DEFAULT_TRADER_CONFIG, flatten_after_close_ms: MAX_MARK_AGE_STOCKS },
        MAX_MARK_AGE_STOCKS,
      ),
    ).not.toThrow();
  });
});

/**
 * #1214 review round 2, finding 2 — the ONE claim the PR body makes about when
 * a bounded-unresolvable flatten row stops blocking its instrument, asserted
 * rather than left as prose. It lives in this file because it is the same
 * family of arithmetic the two assertions above police, and because the
 * derivation reads the Trader's own defaults, which `reconcile.ts` deliberately
 * does NOT import — execution must not depend on the trader, so the constant is
 * duplicated there with its source cited and this test is what stops the two
 * drifting apart silently.
 */
describe("UNRESOLVABLE_FLATTEN_MAX_AGE_MS's flatten-window derivation (#1214)", () => {
  it('equals the pre-bell half of the flatten window, so an already-blocking row is terminal by the bell', () => {
    // The guarantee: a row still blocking when the window OPENS (at
    // `sessionEnd - flatten_before_close_ms`) has been alive at least this long
    // by the bell, so `reconcileFlatten` forces it terminal no later than
    // `sessionEnd` — and reconcile runs on every fill-sync poll (#921) with no
    // calendar gate, so the forcing pass really does land there.
    expect(UNRESOLVABLE_FLATTEN_MAX_AGE_MS).toBe(DEFAULT_TRADER_CONFIG.flatten_before_close_ms);
  });

  it('leaves a post-bell grace with ticks left in it for the unblocked flatten to be submitted', () => {
    // Resolving the row is not the outcome; SUBMITTING the flatten is, and that
    // happens only on a tick (`withinFlattenWindow`). The post-bell grace is
    // what remains after the bound expires, and it has to hold ticks.
    //
    // The boot assertion alone does NOT give that: it requires
    // MIN_TICKS_INSIDE_FLATTEN_WINDOW ticks in `flatten_before_close_ms` but
    // only ONE in the grace (deliberately — see its own comment). The stronger
    // property the bound's derivation leans on is `after >= before`, which is
    // true of `DEFAULT_TRADER_CONFIG` and not enforced anywhere else, so it is
    // pinned HERE, as a defaults property, before the tick arithmetic uses it.
    expect(DEFAULT_TRADER_CONFIG.flatten_after_close_ms).toBeGreaterThanOrEqual(
      DEFAULT_TRADER_CONFIG.flatten_before_close_ms,
    );
    const maxTickInterval =
      DEFAULT_TRADER_CONFIG.flatten_before_close_ms / MIN_TICKS_INSIDE_FLATTEN_WINDOW;
    expect(
      Math.floor(DEFAULT_TRADER_CONFIG.flatten_after_close_ms / maxTickInterval),
    ).toBeGreaterThanOrEqual(MIN_TICKS_INSIDE_FLATTEN_WINDOW);
  });
});
