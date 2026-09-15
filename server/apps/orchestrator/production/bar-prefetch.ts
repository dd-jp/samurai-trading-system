/**
 * Boot-time bar prefetch (#1543) — the cold store is warmed BEFORE the tick
 * loop is armed, not on the first tick's own analyst deadline.
 *
 * ## The defect this closes
 *
 * `production.ts` sizes the analyst per-attempt deadline with
 * `deriveAnalystTimeoutMs(venuePacing.alpaca, universe.length,
 * alpacaFetchBoundMs)` (#1542). That derivation is built on
 * `DISTINCT_BAR_WINDOWS_PER_INSTRUMENT` (`server/shared/http/venue-pacing.ts`),
 * which is 4 — a MEASURED WARM-STORE count (#1080). A first-ever tick against
 * an empty store has no stored history to serve the narrower windows from, so
 * it reaches the venue for every distinct (timeframe, lookback) the pass asks
 * for, drains far past that deadline, and the back of the sweep loses its
 * analyst outputs to a timeout that reports no fault because there was none.
 * The stage then self-heals on the NEXT tick off the fetches the first tick
 * already paid for — recovery by accident rather than by bound.
 *
 * ## Prefetch, not a widened first-tick deadline
 *
 * Widening the deadline for one tick was the alternative and it is refused,
 * not merely passed over. `ATTEMPTS_PER_PERSONA` is 2, so a deadline that
 * covered the cold sweep would put ~140s of analyst wall clock against a
 * 120,000ms tick, and NOTHING downstream refuses that overrun: `paper-profile
 * .ts`'s pass-duration tripwire is a human re-read trigger and no check
 * measures a pass's wall clock (#1104). The overrun would simply happen, group
 * by group, unannounced. Warming off the tick path instead leaves the deadline
 * exactly where #1542 derived it and removes the thing that overran it.
 *
 * ## What this actually guarantees, stated narrowly
 *
 * Not "the first tick makes zero venue calls" — `MarketDataServiceImpl`'s
 * `cachedBars` freshness routes (`server/providers/market-data-service/service.ts`)
 * legitimately re-fetch when a bar interval has rolled between boot and the
 * first tick. What it guarantees is the count that the deadline is sized
 * against: after this runs, the store holds the WIDEST window each timeframe
 * has a production consumer for, so a `getBars` for any narrower window of the
 * same timeframe passes `cachedBars`' `rows.length >= window.lookback` test and
 * is served by route 1 off the tick's own first fetch for that timeframe. The
 * first tick therefore reaches the venue at most once per (instrument,
 * timeframe) — the warm profile `DISTINCT_BAR_WINDOWS_PER_INSTRUMENT` counts —
 * instead of once per distinct window.
 *
 * ## The window list, and why `5m` is 936 rather than `WARMUP_5M`
 *
 * `FIRST_TICK_BAR_WINDOWS` is not chosen; it is the max, per timeframe, over
 * every production call site that requests bars for a universe instrument on a
 * live/paper first tick. #512 derived that list as `WARM_START_WINDOWS` in
 * `server/tools/backfill-market-data.ts`, whose module doc carries the
 * symbol-by-symbol derivation for the `1h` and `1d` lines; that constant now
 * re-exports this one so the hand-run backfill and the boot-time prefetch
 * cannot drift apart.
 *
 * The `5m` line is `RVOL_5M_LOOKBACK` (936), not `WARMUP_5M` (260), and that is
 * a REPAIR of the list's own stated invariant rather than a widening of it:
 * #797 added `computeRvol`'s 936-bar 5m read to `technicalAnalyst.run` AFTER
 * #512 derived the list, so a 260-row warm start left the widest live `5m`
 * consumer cold and the first tick still paid a paginated 936-row crawl per
 * instrument. Over-covering a lookback is free at read time (`cachedBars` asks
 * `rows.length >= lookback`, so one 936-row fetch serves the 260/112/84/81
 * windows too); under-covering it is exactly the silent degrade this ticket
 * reports. The large-`limit` caveat `WARMUP_5M`'s doc waves off does not bind
 * at 936 either — `RVOL_5M_LOOKBACK`'s own doc works that bound out explicitly
 * (~1.4k raw rows, two `PAGE_SIZE` pages, inside `MAX_RAW_LIMIT_ABSOLUTE`).
 *
 * ## `partial` is left at its default, deliberately
 *
 * These windows are requested with no `partial`, i.e. `'error'`. `'allow'`
 * would look like the fail-soft choice and is the opposite: it makes
 * `AlpacaHttpDataClient` return its first short read instead of running the
 * widen-and-retry (#292) that exists to rescue exactly that read, and a stored
 * SHORT window buys the first tick nothing anyway — `cachedBars` misses on
 * `rows.length < lookback` regardless. A genuinely unrescuable window is caught
 * per pair below.
 *
 * ## Fail-soft per pair, unlike `runStartupReconcile`
 *
 * A failure here is logged and stepped over, where a startup reconcile failure
 * propagates out of `start()`. The two are not inconsistent: reconcile is a
 * correctness gate (trading against a store that disagrees with the venue is
 * what it exists to prevent), while this is a latency optimisation for a path
 * that already self-heals. Refusing to boot because one instrument's `1d`
 * window was short would trade a slow first tick for no trading at all.
 */
import { RVOL_5M_LOOKBACK } from '../../../pipeline/analysts/technical-analyst.js';
import type { BarWindow, MarketDataService } from '../../../providers/market-data-service/index.js';
import { describeThrownSafely } from '../../../shared/index.js';
import type { Logger, UniverseInstrument } from '../types.js';

/** See this module's doc for the derivation and for why `5m` is 936 */
export const FIRST_TICK_BAR_WINDOWS: readonly BarWindow[] = [
  { timeframe: '5m', lookback: RVOL_5M_LOOKBACK },
  { timeframe: '1h', lookback: 57 },
  { timeframe: '1d', lookback: 30 },
];

export interface BarPrefetchDeps {
  marketData: Pick<MarketDataService, 'getBars'>;
  universe: readonly UniverseInstrument[];
  asOf: Date;
  logger: Logger;
  traceId: string;
  /** Defaults to `FIRST_TICK_BAR_WINDOWS`; overridable for testing */
  windows?: readonly BarWindow[];
}

export interface BarPrefetchResult {
  warmed: number;
  failed: number;
}

/**
 * Fills the bar store for every (instrument, window) pair, sequentially.
 *
 * Sequential rather than `Promise.all`: two concurrent fetches for the same
 * (instrument, timeframe) race on the store write — the reason
 * `technicalAnalyst.run` already sequences its RVOL read after the shared 5m
 * warm-up rather than bundling them — and the venue token bucket serialises
 * the calls anyway, so fanning out buys latency only by reordering a queue
 * that is already saturated.
 */
export async function prefetchBars(deps: BarPrefetchDeps): Promise<BarPrefetchResult> {
  const windows = deps.windows ?? FIRST_TICK_BAR_WINDOWS;
  let warmed = 0;
  let failed = 0;

  for (const instrument of deps.universe) {
    for (const window of windows) {
      try {
        await deps.marketData.getBars(instrument.asset, window, deps.asOf);
        warmed += 1;
      } catch (error) {
        failed += 1;
        deps.logger.log({
          trace_id: deps.traceId,
          stage: 'market_data',
          event: 'bar_prefetch_window_failed',
          level: 'warn',
          message:
            `bar prefetch could not warm ${instrument.asset} ${window.timeframe} ` +
            `(lookback ${window.lookback}): ${describeThrownSafely(error)}. The first tick will ` +
            'reach the venue for this window itself.',
          payload: {
            instrument: instrument.asset,
            timeframe: window.timeframe,
            lookback: window.lookback,
          },
        });
      }
    }
  }

  deps.logger.log({
    trace_id: deps.traceId,
    stage: 'market_data',
    event: 'bar_prefetch_complete',
    level: failed > 0 ? 'warn' : 'info',
    message:
      `bar prefetch warmed ${warmed} of ${warmed + failed} (instrument, window) pair(s) before ` +
      'the tick loop was armed',
    payload: { warmed, failed, windows: windows.map((w) => `${w.timeframe}/${w.lookback}`) },
  });

  return { warmed, failed };
}
