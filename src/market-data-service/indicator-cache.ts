/**
 * Tier-1 input-hash response cache for `getIndicator` (ticket #65).
 * See docs/specs/market-data-service-spec.md (Module: Caching):
 * key = hash(instrument, kind, spec, asOf); lookback is part of the spec
 * and therefore part of the key, so two different-history values for the
 * same indicator+instrument+asOf never collide.
 */
import type { IndicatorSpec, IndicatorValue } from './types.js';

/** Stable serialization: sorted param keys so equal specs always hash equal. */
export function buildIndicatorCacheKey(
  instrument: string,
  spec: IndicatorSpec,
  asOf: Date,
): string {
  const sortedParams = Object.keys(spec.params)
    .sort()
    .map((key) => `${key}=${spec.params[key]}`)
    .join(',');

  return [instrument, spec.indicator, sortedParams, spec.lookback, asOf.toISOString()].join('|');
}

export class IndicatorCache {
  private readonly entries = new Map<string, IndicatorValue>();

  get(key: string): IndicatorValue | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: IndicatorValue): void {
    this.entries.set(key, value);
  }
}
