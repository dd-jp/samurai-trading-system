/**
 * Timeframe parsing and close-time derivation (ticket #66).
 * See docs/specs/market-data-service-spec.md (Module: Point-in-Time
 * Enforcement): vendor sources timestamp candles at their *open*,
 * so ingestion — not the source — computes `close_time = open_time + timeframe`.
 * This module is the single place that conversion happens.
 */

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `'5m'` -> 300000. Throws on anything this service cannot key bars on. */
export function timeframeToMs(timeframe: string): number {
  const match = /^(\d+)([mhd])$/.exec(timeframe);
  if (!match) {
    throw new Error(`Unsupported timeframe: '${timeframe}' (expected e.g. '1m', '5m', '1h', '1d')`);
  }

  const [, countText, unit] = match;
  const count = Number(countText);
  if (count <= 0) {
    throw new Error(`Unsupported timeframe: '${timeframe}' (count must be positive)`);
  }

  // biome-ignore lint/style/noNonNullAssertion: unit is constrained to [mhd] by the regex.
  return count * UNIT_MS[unit!]!;
}

/** True for day-grained timeframes, whose bar covers an entire session */
export function isDailyTimeframe(timeframe: string): boolean {
  return /^(\d+)d$/.test(timeframe);
}

/**
 * The point-in-time key. A candle for `[t, t+Δ)` becomes visible only at
 * `t+Δ`, which is what keeps the forming candle out of every read.
 */
export function closeTimeOf(openTime: Date, timeframe: string): Date {
  return new Date(openTime.getTime() + timeframeToMs(timeframe));
}
