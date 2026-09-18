export interface ThresholdBound {
  readonly min?: number;
  readonly max?: number;
  readonly source: string;
}

const MEASURED_DRAWDOWN_ENVELOPE = 0.418;

export const GUARDED_THRESHOLD_BOUNDS = {
  max_drawdown_pct: {
    max: 0.45,
    source:
      "David's 2026-08-31 approval of #925, re-siting the ceiling above #798's accepted 41.8% single-stock envelope; engineering choice recorded in cross-spec-contracts.md",
  },
  recovery_drawdown_pct: {
    max: MEASURED_DRAWDOWN_ENVELOPE,
    source: 'ADR-0018 D5 measured envelope; risk-manager-spec.md hysteresis band',
  },
  daily_loss_pct: {
    max: 0.1,
    source: 'engineering choice, derived from max_drawdown_pct (cross-spec-contracts.md)',
  },
  daily_loss_pct_crypto: {
    max: 0.1,
    source: 'engineering choice, derived from max_drawdown_pct (cross-spec-contracts.md)',
  },
  daily_loss_pct_stocks: {
    max: 0.1,
    source: 'engineering choice, derived from max_drawdown_pct (cross-spec-contracts.md)',
  },
  max_pbo: {
    max: 0.05,
    source: "CONTEXT.md 'Kill if PBO > 0.05'; feedback-loop-spec.md story 13",
  },
  min_oos_sharpe: {
    min: 0.5,
    source: "feedback-loop-spec.md story 13 'OOS/paper Sharpe < 0.5'",
  },
  min_deflated_sharpe: {
    min: 0.95,
    source:
      "CONTEXT.md falsification test 'DSR-significant' at the conventional 5% level; feedback-loop-spec.md story 13",
  },
} as const satisfies Readonly<Record<string, ThresholdBound>>;

type GuardedThresholdName = keyof typeof GUARDED_THRESHOLD_BOUNDS;

export const GUARDED_THRESHOLD_NAMES = Object.keys(
  GUARDED_THRESHOLD_BOUNDS,
) as readonly GuardedThresholdName[];

export function boundFor(name: string): ThresholdBound | undefined {
  return Object.hasOwn(GUARDED_THRESHOLD_BOUNDS, name)
    ? GUARDED_THRESHOLD_BOUNDS[name as GuardedThresholdName]
    : undefined;
}

export class ThresholdBoundViolationError extends Error {
  constructor(
    readonly threshold: string,
    readonly value: number,
    readonly bound: ThresholdBound,
    readonly where: string,
  ) {
    const limit =
      bound.min !== undefined && value < bound.min
        ? `must be at least ${bound.min}`
        : `must be at most ${bound.max}`;
    super(
      `${where}: risk threshold '${threshold}' is ${value}, which crosses the in-code clamp — it ${limit}. ` +
        `Source: ${bound.source}. ADR-0013 makes these thresholds the only stop left, so the value is REFUSED, not clamped.`,
    );
    this.name = 'ThresholdBoundViolationError';
  }
}

export function assertThresholdWithinBounds(name: string, value: number, where: string): void {
  const bound = boundFor(name);
  if (bound === undefined) return;

  if (!Number.isFinite(value)) {
    throw new ThresholdBoundViolationError(name, value, bound, where);
  }
  if (bound.min !== undefined && value < bound.min) {
    throw new ThresholdBoundViolationError(name, value, bound, where);
  }
  if (bound.max !== undefined && value > bound.max) {
    throw new ThresholdBoundViolationError(name, value, bound, where);
  }
}

export function assertThresholdsWithinBounds(
  values: Readonly<Record<string, number | undefined>>,
  where: string,
): void {
  const violations: ThresholdBoundViolationError[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    try {
      assertThresholdWithinBounds(name, value, where);
    } catch (error) {
      if (error instanceof ThresholdBoundViolationError) {
        violations.push(error);
        continue;
      }
      throw error;
    }
  }

  if (violations.length === 1) throw violations[0];
  if (violations.length > 1) {
    throw new Error(violations.map((violation) => violation.message).join('\n'));
  }
}

export function isThresholdBoundViolation(error: unknown): boolean {
  if (error instanceof ThresholdBoundViolationError) return true;
  return error instanceof Error && error.message.includes('in-code clamp');
}
