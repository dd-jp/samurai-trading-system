/**
 * Production Composition Root: `VolatilityReadingProvider` (ticket #277).
 * See docs/specs/transport-layer-spec.md ("Module: VolatilityReadingProvider"),
 * closed wayfinder map "Live Transport Layer" (#259), decision #264.
 *
 * Closes `direct-bind.ts`'s `VolatilityReadingProvider` interface
 * (`getVolatilityReading(asOf): Promise<VolatilityReading>`). Reuses the
 * already-shipped pattern at `server/pipeline/execution/simulated-adapter.ts`'s
 * `buildMarketState` — `marketData.getIndicator(instrument,
 * config.volatility_indicator, now)` — no new data source.
 *
 * Aggregation is over the configured universe (`ProductionConfig.universe`),
 * not open positions: `getIndicator` is called for every instrument,
 * partitioned by `asset_class`, and reduced to one number per class via
 * **max** — matching `CircuitBreakers.evaluate`'s conservative,
 * worst-case-trips-it intent, not a smoothed average. Because the universe is
 * populated by config rather than by open positions, a reading is available
 * whenever the venue is; there is no default-instrument fallback for a "no
 * positions open" case (that describes an earlier, inconsistent wayfinder
 * resolution on #264 — superseded, see #277).
 *
 * The one thing that DOES narrow the set is the session calendar: an
 * instrument whose venue is shut at `asOf` is not read at all (issue #386).
 * See `getVolatilityReading` for why, and for why that is not a weakening of
 * the fail-closed posture below.
 *
 * No new caching layer: `getIndicator` calls land on `MarketDataService`'s
 * existing input-hash (Tier-1) response cache
 * (market-data-service-spec.md), so repeat calls within the same tick are
 * already deduplicated there.
 *
 * Fail-closed at the `getIndicator` boundary: this feeds `CircuitBreakers`,
 * a live-money risk gate, so a single flaky instrument (rejected call, or a
 * non-finite value such as `NaN` from insufficient ATR bars) must not
 * silently drop out of the max aggregation or produce a `NaN` that makes
 * every breaker comparison false. `Promise.allSettled` + `Number.isFinite`
 * guard the boundary; a failure is aggregated in as `FAILURE_READING`
 * (`Infinity`), tripping the breaker conservatively instead of going inert.
 *
 * Wired by default in `production.ts` (`volatility: config.volatility ?? new
 * MarketDataVolatilityReadingProvider({…})`), alongside the
 * `AccountStateProvider` the same call site needs — `ProductionConfig
 * .volatility` is an OPTIONAL override, not the required injected field this
 * comment described before the composition root caught up (#1280).
 *
 * That is what puts `getVolatilityReading` inside the tick: it runs from the
 * per-instrument Risk stage, under `TickRunner`'s `runWithTraceId`, which is
 * why its two failure logs join the tick's trace and `warnIfClassEmpty` —
 * construction-time, before any tick — does not.
 */
import type { VolatilityReading } from '../../../pipeline/risk-manager/index.js';
import type {
  IndicatorSpec,
  IndicatorValue,
  MarketDataService,
  TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import { currentTraceId, describeThrownSafely } from '../../../shared/index.js';
import type { AssetClass, Logger, UniverseInstrument } from '../types.js';
import type { VolatilityReadingProvider } from './direct-bind.js';

export interface VolatilityReadingProviderConfig {
  marketData: MarketDataService;
  /** The full configured universe — aggregated over unconditionally, not gated on open positions. */
  universe: readonly UniverseInstrument[];
  /** Same indicator spec `SimulatedAdapterConfig.volatility_indicator` reads for `MarketState.volatility`. */
  volatility_indicator: IndicatorSpec;
  /**
   * Session calendars per asset class — the same pair `UniverseScheduler`
   * gates its tick plan on, so the two cannot disagree about when a venue is
   * open (issue #386; see `getVolatilityReading`).
   *
   * Required rather than defaulted to always-open: a defaulted calendar is a
   * gate that a future wiring change can silently drop, and the failure it
   * prevents (a permanently armed `volatility_halt:stocks` overnight) looks
   * exactly like a working system from the outside.
   */
  calendars: Record<AssetClass, TradingCalendar>;
  /** Failures and empty-class config slips are logged, not silently absorbed (see FAILURE_READING). */
  logger: Logger;
}

/**
 * No instruments of a class to read at `asOf` — either none in the universe,
 * or none whose venue is open (issue #386; see `getVolatilityReading`). No
 * reading, so the breaker never trips on a class it cannot observe. Safe even
 * at a 0 configured baseline —
 * `CircuitBreakers.evaluate`'s volatility check is a strict `>`, so a 0
 * reading never trips regardless of baseline. This is also today's actual
 * live behavior for `stocks`, not just a corner case: `SMOKE_TEST_UNIVERSE`
 * (the default `ProductionConfig.universe`) is crypto-only, so the `stocks`
 * class reads 0 until the universe is widened. Because this can also be an
 * unintentional config slip, it is logged at `warn` so it doesn't silently
 * disable a risk tier — see `warnIfClassEmpty`.
 */
const NO_READING = 0;

/**
 * Fail-closed sentinel for a per-instrument failure: a rejected
 * `getIndicator` call, or a non-finite (`NaN`/non-number) value — e.g. ATR
 * with insufficient bars. This feeds `CircuitBreakers.evaluate`, a
 * live-money risk gate whose volatility check is `reading > baseline *
 * multiplier`; letting a failure silently drop out of the `Math.max`
 * aggregation (or worse, propagate a `NaN` that makes every `>` comparison
 * false) would silently disable the breaker for that asset class. `Infinity`
 * guarantees the class's max exceeds any finite baseline/multiplier, so a
 * flaky instrument trips conservative — matching the module's max-aggregation,
 * worst-case-wins intent — instead of going inert.
 *
 * Never persisted: `CircuitBreakers.evaluate` (breakers.ts) only compares this
 * value against `baseline * multiplier` and folds the *boolean* trip result
 * into `BreakerState`/`PersistedBreakerState` — the raw reading itself never
 * reaches `getPersistedState()` or any store, so `Infinity`'s lossy JSON
 * round-trip (`JSON.stringify` -> `null`) is not a live risk here. If a
 * future caller ever snapshots this reading directly, revisit this sentinel.
 */
const FAILURE_READING = Number.POSITIVE_INFINITY;

/**
 * Single source of truth for the asset classes this provider aggregates —
 * every asset-class-shaped list/lookup below (`warnIfClassEmpty` calls,
 * `maxByClass` keys) derives from this instead of repeating the literal
 * union, so widening `AssetClass` can't silently drop a class from the
 * reading.
 */
const ASSET_CLASSES = ['crypto', 'stocks'] as const satisfies readonly AssetClass[];

/**
 * Caps in-flight `getIndicator` calls per `getVolatilityReading` invocation.
 * A widened universe (hundreds of instruments) firing unbounded concurrent
 * calls can burst against the upstream market-data provider's rate limit;
 * rejections then fail-closed to `Infinity` and spuriously trip the
 * volatility breaker. This is deliberately a plain worker-pool loop rather
 * than a new dependency (none of the concurrency-limiter packages are
 * already in package.json).
 */
const MAX_CONCURRENT_INDICATOR_CALLS = 8;

export class MarketDataVolatilityReadingProvider implements VolatilityReadingProvider {
  constructor(private readonly config: VolatilityReadingProviderConfig) {
    // Fires once at construction, not per tick: the standing default universe is
    // crypto-only (see NO_READING doc comment above), so logging this on every
    // `getVolatilityReading` call would emit a permanent per-tick warn stream on a
    // risk-gate path, training operators to ignore it. A config slip is still visible
    // once, at startup.
    for (const asset_class of ASSET_CLASSES) {
      warnIfClassEmpty(config.universe, asset_class, config.logger);
    }
  }

  /**
   * Aggregated over the instruments whose venue is OPEN at `asOf` — not the
   * whole configured universe (issue #386).
   *
   * A shut venue has no current volatility to read. Before this gate, every
   * equity was read overnight anyway: with `DEFAULT_UNIVERSE` (#381) that is
   * four `getIndicator` calls per tick that cannot succeed, each folded in as
   * `FAILURE_READING` (`Infinity`) and each logged at `error`. Measured on a
   * live paper run: exactly four error lines per tick, ~5,700 a day, and a
   * soft `volatility_halt:stocks` armed for ~16 hours a weekday and all
   * weekend — driven by a bar-count artifact rather than by any market
   * condition. That is the alert-fatigue failure mode #383 and #362 already
   * fixed elsewhere, and it is worse here because an operator trained to
   * scroll past `error` scrolls past the stuck-fill and kill-threshold lines
   * too.
   *
   * The fail-closed handling below is deliberately UNCHANGED. It is the right
   * answer to "this indicator is unreadable and I don't know why"; it was the
   * wrong answer only because "unreadable" was the expected state most of the
   * day. Gating the read makes that correct by construction: a class with no
   * open instrument aggregates to `NO_READING` (0, inert, and re-armed on the
   * next in-session tick) via the same empty-class path a class absent from
   * the universe takes, so nothing has to distinguish "shut" from "broken"
   * after the fact. An in-session instrument that fails still trips the
   * breaker conservatively.
   *
   * A 0 reading for a shut class is safe because this reading is ENTRY-side
   * only, which is worth stating since an equity position can be held
   * overnight and "0" would otherwise read as "calm" rather than
   * "unobserved". `CircuitBreakers.evaluate` folds it into
   * `asset_class_tripped`, and that field has exactly two consumers:
   * `RiskManagerImpl.evaluate`'s Step-1 gate, which an `intent_type: 'exit'`
   * returns before ever reaching ("bypasses all entry gates"), and
   * `verdict`'s `breaker` gate (5), which for stocks sits behind the
   * `market_closed` gate (4) anyway. No exit, stop-widen, or kill-line path
   * reads it, and the raw reading is never persisted — only the boolean trip
   * result is.
   *
   * This is the noise half of #386. The correctness half is
   * `NormalizingDataSource.fetchBars`'s in-session bar-count guarantee: the
   * Trader sizes stops off the same ATR read DURING the session, where no
   * calendar gate can help it.
   */
  async getVolatilityReading(asOf: Date): Promise<VolatilityReading> {
    const { marketData, universe, volatility_indicator, calendars, logger } = this.config;

    const open = universe.filter((instrument) => calendars[instrument.asset_class].isOpen(asOf));

    const settled = await settleWithConcurrency(
      open,
      MAX_CONCURRENT_INDICATOR_CALLS,
      (instrument) => marketData.getIndicator(instrument.asset, volatility_indicator, asOf),
    );

    const readings = open.map((instrument, index) => {
      // Safe: `settled` was built via `settleWithConcurrency(open, ...)`, so it has
      // exactly one entry per instrument at the same index — `as` avoids a spurious
      // `noUncheckedIndexedAccess`.
      const result = settled[index] as PromiseSettledResult<IndicatorValue>;

      if (result.status === 'rejected') {
        logger.log({
          // `getVolatilityReading` is called only from the per-instrument
          // Risk stage (direct-bind.ts's `computeCurrentPortfolioAndBreakers`),
          // so this joins that tick when there is one (#1280) — unlike
          // `warnIfClassEmpty` below, which fires at construction, never
          // in-tick, and keeps its bare constant.
          trace_id: currentTraceId() ?? 'volatility-reading-provider',
          stage: 'volatility-reading-provider',
          event: 'volatility_indicator_rejected',
          level: 'error',
          message:
            'getIndicator rejected; treating instrument as fail-closed (max reading) rather than excluding it',
          payload: {
            instrument: instrument.asset,
            asset_class: instrument.asset_class,
            error: sanitizeErrorMessage(describeThrownSafely(result.reason)),
          },
        });
        return { asset_class: instrument.asset_class, value: FAILURE_READING };
      }

      const { value } = result.value;
      if (!Number.isFinite(value)) {
        logger.log({
          // Same reasoning as the rejected-result branch above.
          trace_id: currentTraceId() ?? 'volatility-reading-provider',
          stage: 'volatility-reading-provider',
          event: 'volatility_indicator_non_finite',
          level: 'error',
          message:
            'getIndicator returned a non-finite value; treating instrument as fail-closed (max reading) rather than excluding it',
          payload: { instrument: instrument.asset, asset_class: instrument.asset_class, value },
        });
        return { asset_class: instrument.asset_class, value: FAILURE_READING };
      }

      return { asset_class: instrument.asset_class, value };
    });

    return {
      crypto: maxByClass(readings, 'crypto'),
      stocks: maxByClass(readings, 'stocks'),
    };
  }
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once,
 * settling every one (rejections captured, never thrown) — a dependency-free
 * stand-in for `Promise.allSettled` with a concurrency bound. Order of the
 * returned array matches `items`, regardless of completion order.
 */
async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      // Safe: `index` is claimed under the `nextIndex < items.length` guard above, so it's
      // always in bounds — `as` avoids a spurious `noUncheckedIndexedAccess`.
      const item = items[index] as T;
      try {
        const value = await fn(item);
        results[index] = { status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

/**
 * Strips query-string-shaped substrings (`?key=value` / `&key=value`) and
 * caps length before a market-data client's error message hits the logs.
 * HTTP client errors commonly echo the full request URL, and market-data
 * providers commonly put API keys in query params — logging `error.message`
 * raw risks leaking credentials into log storage.
 */
function sanitizeErrorMessage(message: string): string {
  const MAX_LENGTH = 200;
  const redacted = message.replace(/([?&][\w.-]+=)[^\s&]*/g, '$1[redacted]');
  return redacted.length > MAX_LENGTH ? `${redacted.slice(0, MAX_LENGTH)}…` : redacted;
}

/** See `NO_READING` doc comment: a config slip should be visible, not silently inert. */
function warnIfClassEmpty(
  universe: readonly UniverseInstrument[],
  asset_class: AssetClass,
  logger: Logger,
): void {
  if (universe.some((instrument) => instrument.asset_class === asset_class)) {
    return;
  }
  logger.log({
    trace_id: 'volatility-reading-provider',
    stage: 'volatility-reading-provider',
    event: 'volatility_universe_empty',
    level: 'warn',
    message:
      'no instruments configured for asset class; volatility breaker reads 0 (inert) for this class',
    payload: { asset_class },
  });
}

function maxByClass(
  readings: readonly { asset_class: AssetClass; value: number }[],
  asset_class: AssetClass,
): number {
  const values = readings
    .filter((reading) => reading.asset_class === asset_class)
    .map((reading) => reading.value);
  return values.length === 0 ? NO_READING : Math.max(...values);
}
