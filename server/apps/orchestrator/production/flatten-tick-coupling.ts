import type { TraderConfig } from '../../../pipeline/trader/index.js';

export const MIN_TICKS_INSIDE_FLATTEN_WINDOW = 2;

export function assertFlattenWindowCoversTickInterval(
  traderConfig: TraderConfig,
  tickIntervalMs: number,
): void {
  if (!Number.isFinite(tickIntervalMs) || tickIntervalMs <= 0) {
    throw new Error(
      `tickIntervalMs must be a positive, finite number of milliseconds, got ${tickIntervalMs}. ` +
        'Flat-by-close is evaluated on a tick, so a non-positive interval means there is no ' +
        'tick rate for the flatten window to be checked against (#670).',
    );
  }

  const window = traderConfig.flatten_before_close_ms;
  const required = MIN_TICKS_INSIDE_FLATTEN_WINDOW * tickIntervalMs;
  if (window < required) {
    const ticksInWindow = (window / tickIntervalMs).toFixed(2);
    throw new Error(
      `traderConfig.flatten_before_close_ms (${window}ms) must be at least ` +
        `${MIN_TICKS_INSIDE_FLATTEN_WINDOW}x tickIntervalMs (${tickIntervalMs}ms = ${required}ms), ` +
        `but only ${ticksInWindow} tick(s) fit inside the flatten window. ` +
        'Flat-by-close is evaluated ON a tick, so a window this narrow is stepped over: the ' +
        'position carries overnight against ADR-0014 with nothing logged as an error. ' +
        'Widen flatten_before_close_ms or shorten tickIntervalMs (#670).',
    );
  }

  const grace = traderConfig.flatten_after_close_ms;
  if (grace < tickIntervalMs) {
    throw new Error(
      `traderConfig.flatten_after_close_ms (${grace}ms) must be at least tickIntervalMs ` +
        `(${tickIntervalMs}ms), but only ${(grace / tickIntervalMs).toFixed(2)} tick(s) fit ` +
        "inside the post-close flatten grace. The grace is #1389's second chance at a lot the " +
        'pre-close window missed, and it is evaluated ON a tick too — a grace no tick lands in ' +
        'restores the forward-only window, silently. Widen flatten_after_close_ms or shorten ' +
        'tickIntervalMs (#1389).',
    );
  }
}

export function assertFlattenGraceWithinMarkAge(
  traderConfig: TraderConfig,
  verdictMaxMarkAgeStocksMs: number,
): void {
  const grace = traderConfig.flatten_after_close_ms;
  if (grace <= verdictMaxMarkAgeStocksMs) return;

  throw new Error(
    `traderConfig.flatten_after_close_ms (${grace}ms) must not exceed ` +
      `verdictConfig.max_mark_age.stocks (${verdictMaxMarkAgeStocksMs}ms). A priced mandatory ` +
      'flatten is NOT exempt from Verdict gate 2a, so past that age every post-close flatten is ' +
      'refused `stale_feed` — the extra grace produces ticks that cannot transact while reading ' +
      'like a grace that works (#1389).',
  );
}
