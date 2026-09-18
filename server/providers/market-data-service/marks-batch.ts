import type { Mark, MarkRead } from './types.js';

export async function collectMarks(
  getMark: (instrument: string, asOf: Date) => Promise<Mark>,
  instruments: readonly string[],
  asOf: Date,
): Promise<Map<string, MarkRead>> {
  const distinct = [...new Set(instruments)];
  const reads = await Promise.all(
    distinct.map(async (instrument): Promise<readonly [string, MarkRead]> => {
      try {
        return [instrument, { ok: true, mark: await getMark(instrument, asOf) }];
      } catch (error) {
        return [instrument, { ok: false, error }];
      }
    }),
  );
  return new Map(reads);
}
