export interface TrailingReturnParams {
  readonly lookbackDays: number;
  readonly skipDays: number;
}

export type CloseAt = (calendarIndex: number) => number | undefined;

export function trailingReturn(
  closeAt: CloseAt,
  decisionIndex: number,
  params: TrailingReturnParams,
): number | undefined {
  if (params.skipDays < 0 || params.lookbackDays <= params.skipDays) {
    throw new Error(
      `trailingReturn: need 0 <= skipDays < lookbackDays (got ${params.skipDays}, ${params.lookbackDays})`,
    );
  }
  const startIndex = decisionIndex - params.lookbackDays;
  if (startIndex < 0) return undefined;
  const start = closeAt(startIndex);
  const end = closeAt(decisionIndex - params.skipDays);
  if (start === undefined || end === undefined || start <= 0) return undefined;
  return end / start - 1;
}

export type TrendState = 'long' | 'flat';

export function timeSeriesTrend(trailing: number): TrendState {
  return trailing > 0 ? 'long' : 'flat';
}

export function crossSectionalTopK(scores: ReadonlyMap<string, number>, k: number): string[] {
  if (!Number.isInteger(k) || k < 1)
    throw new Error(`crossSectionalTopK: k must be >= 1 (got ${k})`);
  return [...scores.entries()]
    .sort(([symbolA, scoreA], [symbolB, scoreB]) =>
      scoreB !== scoreA ? scoreB - scoreA : symbolA.localeCompare(symbolB),
    )
    .slice(0, k)
    .map(([symbol]) => symbol);
}
