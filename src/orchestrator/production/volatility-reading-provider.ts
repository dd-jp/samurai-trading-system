/**
 * Production Composition Root: `VolatilityReadingProvider` (ticket #277).
 * See docs/specs/transport-layer-spec.md ("Module: VolatilityReadingProvider"),
 * closed wayfinder map "Live Transport Layer" (#259), decision #264.
 *
 * Closes `direct-bind.ts`'s `VolatilityReadingProvider` interface
 * (`getVolatilityReading(asOf): Promise<VolatilityReading>`). Reuses the
 * already-shipped pattern at `src/execution/simulated-adapter.ts`'s
 * `buildMarketState` — `marketData.getIndicator(instrument,
 * config.volatility_indicator, now)` — no new data source.
 *
 * Aggregation is always over the full configured universe
 * (`ProductionConfig.universe`), not open positions: `getIndicator` is
 * called for every instrument, partitioned by `asset_class`, and reduced to
 * one number per class via **max** — matching `CircuitBreakers.evaluate`'s
 * conservative, worst-case-trips-it intent, not a smoothed average. Because
 * the universe is populated by config rather than by open positions, a
 * reading is always available; there is no default-instrument fallback for
 * a "no positions open" case (that describes an earlier, inconsistent
 * wayfinder resolution on #264 — superseded, see #277).
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
 * Not yet wired into `production.ts`: `ProductionConfig.volatility` stays a
 * required injected field for now (composition-root wiring is a separate
 * concern from closing this interface, and `AccountStateProvider` — the
 * other required field `computeCurrentPortfolioAndBreakers` needs alongside
 * it — has no in-repo implementation yet either).
 */
import type {
  IndicatorSpec,
  IndicatorValue,
  MarketDataService,
} from '../../market-data-service/index.js';
import type { VolatilityReading } from '../../risk-manager/index.js';
import type { AssetClass, Logger, UniverseInstrument } from '../types.js';
import type { VolatilityReadingProvider } from './direct-bind.js';

export interface VolatilityReadingProviderConfig {
  marketData: MarketDataService;
  /** The full configured universe — aggregated over unconditionally, not gated on open positions. */
  universe: readonly UniverseInstrument[];
  /** Same indicator spec `SimulatedAdapterConfig.volatility_indicator` reads for `MarketState.volatility`. */
  volatility_indicator: IndicatorSpec;
  /** Failures and empty-class config slips are logged, not silently absorbed (see FAILURE_READING). */
  logger: Logger;
}

/**
 * No instruments of a class in the universe: no reading, so the breaker
 * never trips on an absent class. Safe even at a 0 configured baseline —
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

  async getVolatilityReading(asOf: Date): Promise<VolatilityReading> {
    const { marketData, universe, volatility_indicator, logger } = this.config;

    const settled = await settleWithConcurrency(
      universe,
      MAX_CONCURRENT_INDICATOR_CALLS,
      (instrument) => marketData.getIndicator(instrument.asset, volatility_indicator, asOf),
    );

    const readings = universe.map((instrument, index) => {
      // Safe: `settled` was built via `settleWithConcurrency(universe, ...)`, so it has
      // exactly one entry per instrument at the same index — `as` avoids a spurious
      // `noUncheckedIndexedAccess`.
      const result = settled[index] as PromiseSettledResult<IndicatorValue>;

      if (result.status === 'rejected') {
        logger.log({
          trace_id: 'volatility-reading-provider',
          stage: 'volatility-reading-provider',
          level: 'error',
          message:
            'getIndicator rejected; treating instrument as fail-closed (max reading) rather than excluding it',
          payload: {
            instrument: instrument.asset,
            asset_class: instrument.asset_class,
            error: sanitizeErrorMessage(
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            ),
          },
        });
        return { asset_class: instrument.asset_class, value: FAILURE_READING };
      }

      const { value } = result.value;
      if (!Number.isFinite(value)) {
        logger.log({
          trace_id: 'volatility-reading-provider',
          stage: 'volatility-reading-provider',
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
