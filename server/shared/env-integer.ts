
export function nonEmpty(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function isIntegerAtLeast(value: number, min: number): boolean {
  return Number.isSafeInteger(value) && value >= min;
}

export function requireIntegerAtLeast(
  value: number,
  name: string,
  min: number,
  purpose: string,
): number {
  if (!isIntegerAtLeast(value, min)) {
    throw new Error(
      `Orchestrator cannot start: ${name} must be an integer >= ${min}, not ` +
        `${JSON.stringify(value)}. It is ${purpose}; refused rather than defaulted, the same rule ` +
        'a malformed environment value is held to.',
    );
  }
  return value;
}

export function positiveIntegerFromEnv(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  purpose: string,
): number {
  const value = nonEmpty(raw);
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!isIntegerAtLeast(parsed, min)) {
    throw new Error(
      `Orchestrator cannot start: ${name} must be an integer >= ${min}, not ` +
        `${JSON.stringify(value)}. It is ${purpose}; a value nobody meant is a setting nobody ` +
        'chose, so it is refused rather than defaulted. Unset it to accept the ' +
        `default (${fallback}).`,
    );
  }
  return parsed;
}
