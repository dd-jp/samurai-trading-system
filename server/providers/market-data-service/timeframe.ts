
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

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

export function isDailyTimeframe(timeframe: string): boolean {
  return /^(\d+)d$/.test(timeframe);
}

export function closeTimeOf(openTime: Date, timeframe: string): Date {
  return new Date(openTime.getTime() + timeframeToMs(timeframe));
}
