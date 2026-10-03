export function parseIsoInstant(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RangeError(
      `Expected a UTC ISO 8601 instant such as 2026-01-02T03:04:05.678Z, got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}
