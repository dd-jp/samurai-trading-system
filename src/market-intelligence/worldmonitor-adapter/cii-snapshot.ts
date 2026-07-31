/**
 * Periodic CII history capture (#182), a follow-on to the CII soft signal
 * (ADR-0002, cii-consumer.ts). WorldMonitor retains no historical CII series
 * of its own (~24h trend-delta only — ADR-0002 §6), which is why the
 * drawdown-correlation study #173 wanted to run couldn't — it's blocked on
 * Samurai accumulating its own ~90 days of history first. This module is
 * that capture path.
 *
 * Reads `CiiScoreProvider.getCii` directly rather than going through
 * `CiiConsumer.getScores` — the consumer's cache exists so the Risk
 * Manager's synchronous `evaluate()` never blocks on a network call, serves
 * `{}` on a cold process, and doesn't expose when a score was actually
 * observed. A snapshot job has none of those constraints and specifically
 * wants a true observation timestamp for `captured_at`.
 *
 * Like `client.ts`/`normalizer.ts`/`adapter.ts` (the live SDK wiring),
 * nothing in `src/` calls this yet — there is no live `CiiScoreProvider`
 * and no scheduler wired anywhere in this pre-launch codebase (matching
 * `runDailyCycle`'s pattern: a pure function invoked externally, not a
 * sidecar daemon). #182 stays open after this lands — it also covers the
 * 90-day correlation study itself, which remains uncomputable until this
 * capture path has been running against a live adapter for that long.
 */
import type { Clock } from '../../shared/index.js';
import type { CiiScoreProvider } from './cii-consumer.js';

export interface CiiSnapshotRow {
  country_code: string;
  score: number;
  captured_at: Date;
}

export interface CiiSnapshotStore {
  /** Append-only: one row per (country_code, captured_at). */
  record(row: CiiSnapshotRow): void;
}

/**
 * Captures one snapshot per requested country. A country the provider has no
 * score for (`null`, per `CiiScoreProvider`'s contract) or that rejects is
 * skipped — logged, not recorded as a NULL/zero row — so an eventual
 * `AVG(score)` over the history isn't silently corrupted by absence. One
 * country's failure does not stop the others from being captured.
 */
export async function captureCiiSnapshot(
  countryCodes: readonly string[],
  provider: CiiScoreProvider,
  store: CiiSnapshotStore,
  clock: Clock,
): Promise<void> {
  const capturedAt = clock.now();

  await Promise.all(
    countryCodes.map(async (country) => {
      try {
        const score = await provider.getCii(country);
        if (score === null) {
          return;
        }
        store.record({ country_code: country, score, captured_at: capturedAt });
      } catch (error) {
        // Covers both `provider.getCii` rejecting and `store.record` throwing (e.g. an
        // out-of-range score tripping SqliteCiiSnapshotStore's guard) — either one is one
        // country's failure, and the header's guarantee is that it doesn't stop the others.
        console.error(`[cii-snapshot] capture failed for country=${country}:`, error);
      }
    }),
  );
}
