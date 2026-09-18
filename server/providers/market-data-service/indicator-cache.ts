import type { IndicatorSpec, IndicatorValue } from './types.js';

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
    spec.timeframe,
    asOf.toISOString(),
  ].join('|');
}

const DEFAULT_MAX_ENTRIES = 50_000;

export class IndicatorCache {
  private readonly entries = new Map<string, IndicatorValue>();

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  get(key: string): IndicatorValue | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
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
