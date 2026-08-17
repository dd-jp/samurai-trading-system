/**
 * The one fan-out behind `MarketDataService.getMarks` (#289 H8).
 *
 * `DataSource` exposes no batch `fetchMark`, so every implementation of the
 * batch read is the same three decisions over a per-instrument read: dedup the
 * request, attempt every instrument even after one has failed, and turn a
 * throw into a `MarkRead` rather than letting it reject the batch. Written
 * once here so `MarketDataServiceImpl` and every test double that composes a
 * `getMark` cannot drift apart on the partial-failure policy — which is the
 * whole property `computePortfolioView` depends on.
 */
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
