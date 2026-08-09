/**
 * The `analyst_weights` writer that has to run before any other one can (#371).
 *
 * `runDailyCycle` steps a weight it can already read and skips an analyst with
 * no row — "seeding it is the weight store's job, not a tuning cycle's"
 * (daily-cycle.ts). Nothing was that job's owner, so on a fresh store the
 * cycle attributed real closed trades against real `debate_log` rows and then
 * `continue`d past every analyst, forever: an empty table, no
 * `analyst_weight` adjustments, and a soak report reading "the Feedback Loop
 * ran cleanly every day".
 *
 * ## Idempotent by row presence, never by value
 *
 * The one property that matters more than seeding at all: a restart must not
 * touch a weight the loop has already moved. Over the 14-day soak (#238) the
 * process restarts, and a seeder that wrote its neutral value on every boot
 * would erase every step taken since the last one — a loop that re-flattens
 * itself daily while logging tuning activity is strictly worse than the empty
 * table this replaces, because it looks like learning.
 *
 * So the test is "is there a row", not "is the value still neutral". A weight
 * that has legitimately tuned back to the midpoint is indistinguishable by
 * value from an untouched seed, and rewriting it would also destroy
 * `updated_at` — the only record of when the loop last moved that dial.
 *
 * And that test belongs to the WRITE, not to this function (PR #376 review).
 * This deliberately does not read the weight map and then write the gaps: two
 * processes overlapping across a restart — which is what a 14-day soak's
 * restarts actually produce — can both read "absent" before either writes,
 * and the loser then flattens a tuned weight back to the midpoint. Nothing
 * would surface that: the value looks exactly like a healthy seed. So each id
 * goes through `TuningStore.seedAnalystWeight`, one first-write-wins
 * statement (`ON CONFLICT DO NOTHING` in SQLite), and the idempotence is a
 * property of the store rather than of this caller's discipline.
 */
import type { TuningStore } from '../../shared/index.js';
import { bandMidpoint } from './attribution.js';
import type { TunableDial } from './types.js';

export interface SeedAnalystWeightsInput {
  /** The live store. Written through `seedAnalystWeight` only — never read. */
  tuning: TuningStore;
  /**
   * The analysts the composition root actually builds, by the `analyst_id`
   * the debate log records — the same key `accumulateCredit` accumulates
   * under, and therefore the same key `runDailyCycle` looks up. Seeding any
   * other spelling would leave the cycle skipping exactly as before.
   */
  analyst_ids: readonly string[];
  /**
   * The weights dial from the live `FeedbackConfig`, for its band — not for
   * its `max_step`, which bounds a tuning step and has nothing to say about
   * where an untuned analyst starts.
   */
  dial: TunableDial;
}

export interface SeedAnalystWeightsResult {
  /** Ids given a fresh neutral row by this call, in input order. */
  seeded: string[];
  /** Ids left exactly as the store had them, in input order. */
  existing: string[];
}

/**
 * Writes a neutral weight for every analyst that has no row yet, and returns
 * which ids fell on each side. Safe to call on every boot.
 */
export function seedAnalystWeights(input: SeedAnalystWeightsInput): SeedAnalystWeightsResult {
  // `bandMidpoint`, shared with `impliedWeight` rather than re-derived here:
  // the seed must be the exact value a genuinely even record is pulled toward
  // (`tanh(0) === 0`), or the first cycles are a drift back to the middle
  // rather than a response to evidence. Derived, never the 1.0 the paper
  // profile's `[0.5, 1.5]` band makes it — re-centring the band must move the
  // seed with it.
  const neutral = bandMidpoint(input.dial);

  const seeded: string[] = [];
  const existing: string[] = [];
  // Deduped so a persona list that names an analyst twice cannot report it
  // twice — or, worse, count a row this same call just wrote as pre-existing.
  const seen = new Set<string>();

  for (const analyst_id of input.analyst_ids) {
    if (seen.has(analyst_id)) {
      continue;
    }
    seen.add(analyst_id);

    // The store decides, not a check up here: `seedAnalystWeight` is
    // first-write-wins in one statement, so there is no window between
    // "is it there?" and "write it" for a concurrently-booting process to
    // tune a weight inside. The boolean is the store's own answer to which
    // side this id fell on.
    if (input.tuning.seedAnalystWeight(analyst_id, neutral)) {
      seeded.push(analyst_id);
    } else {
      existing.push(analyst_id);
    }
  }

  return { seeded, existing };
}
