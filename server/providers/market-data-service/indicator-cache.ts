/**
 * Tier-1 input-hash response cache for `getIndicator` (ticket #65).
 * See docs/specs/market-data-service-spec.md (Module: Caching):
 * key = hash(instrument, kind, spec, asOf); lookback AND timeframe are part
 * of the spec and therefore part of the key, so neither two different-history
 * values nor two different-timeframe values for the same
 * indicator+instrument+asOf can collide (#315).
 */
import type { IndicatorSpec, IndicatorValue } from './types.js';

/** Stable serialization: sorted param keys so equal specs always hash equal */
export function buildIndicatorCacheKey(
  instrument: string,
  spec: IndicatorSpec,
  asOf: Date,
): string {
  const sortedParams = Object.keys(spec.params)
    .sort()
    .map((key) => `${key}=${spec.params[key]}`)
    .join(',');

  return [
    instrument,
    spec.indicator,
    sortedParams,
    spec.lookback,
    // #315: two specs differing only in timeframe are different values. Before
    // the spec carried one, every key described a 1h bar by construction
    spec.timeframe,
    asOf.toISOString(),
  ].join('|');
}

/**
 * Keys include `asOf`, so a long backtest or long-lived live process mints a
 * fresh key per bar per indicator — unbounded, the cache is an OOM slow leak
 * (code-review 2026-08-01, C4). Ample for any realistic working set (six
 * instruments x a handful of indicators x thousands of bars) while keeping
 * the ceiling.
 */
const DEFAULT_MAX_ENTRIES = 50_000;

export class IndicatorCache {
  private readonly entries = new Map<string, IndicatorValue>();

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  get(key: string): IndicatorValue | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      // LRU touch: Map preserves insertion order, so re-inserting moves the
      // key to the young end and eviction below always takes the coldest
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: IndicatorValue): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, value);
  }
}
