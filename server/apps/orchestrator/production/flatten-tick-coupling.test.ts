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
    expect(() =>
      assertFlattenWindowCoversTickInterval(configWithWindow(5 * MINUTE), 15 * MINUTE),
    ).toThrow(/flatten_before_close_ms/);
  });

  it('names both numbers and how many ticks actually fit, not just that it failed', () => {
    expect(() =>
      assertFlattenWindowCoversTickInterval(configWithWindow(5 * MINUTE), 15 * MINUTE),
    ).toThrow(/only 0\.33 tick\(s\) fit/);
  });

  it('accepts a window that fits the required number of ticks exactly', () => {
    const tick = 2 * MINUTE;
    expect(() =>
      assertFlattenWindowCoversTickInterval(
        configWithWindow(MIN_TICKS_INSIDE_FLATTEN_WINDOW * tick),
        tick,
      ),
    ).not.toThrow();
  });

  it('rejects a window one tick wide, which the bare arithmetic would allow', () => {
    const tick = 5 * MINUTE;
    expect(() => assertFlattenWindowCoversTickInterval(configWithWindow(tick), tick)).toThrow(
      /only 1\.00 tick\(s\) fit/,
    );
  });

  it('rejects a zero tick interval instead of passing it vacuously (#711 review)', () => {
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
    expect(() =>
      assertFlattenWindowCoversTickInterval(DEFAULT_TRADER_CONFIG, MINUTE),
    ).not.toThrow();
  });

  describe('the post-close grace (#1389)', () => {
    function configWithGrace(flattenAfterCloseMs: number): TraderConfig {
      return {
        ...DEFAULT_TRADER_CONFIG,
        flatten_before_close_ms: 60 * MINUTE,
        flatten_after_close_ms: flattenAfterCloseMs,
      };
    }

    it('rejects a grace shorter than one tick interval', () => {
      expect(() =>
        assertFlattenWindowCoversTickInterval(configWithGrace(2 * MINUTE), 15 * MINUTE),
      ).toThrow(/flatten_after_close_ms .* must be at least tickIntervalMs/);
    });

    it('accepts a grace of exactly one tick interval', () => {
      expect(() =>
        assertFlattenWindowCoversTickInterval(configWithGrace(MINUTE), MINUTE),
      ).not.toThrow();
    });

    it('checks the grace even when the pre-close window is generous', () => {
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

describe("UNRESOLVABLE_FLATTEN_MAX_AGE_MS's flatten-window derivation (#1214)", () => {
  it('equals the pre-bell half of the flatten window, so an already-blocking row is terminal by the bell', () => {
    expect(UNRESOLVABLE_FLATTEN_MAX_AGE_MS).toBe(DEFAULT_TRADER_CONFIG.flatten_before_close_ms);
  });

  it('leaves a post-bell grace with ticks left in it for the unblocked flatten to be submitted', () => {
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
