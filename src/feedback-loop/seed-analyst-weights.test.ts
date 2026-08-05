/**
 * #371 — the seeder's two properties: it populates the table a fresh store
 * has nothing in, and it NEVER touches a row that already exists.
 *
 * The second is the one with teeth. Over a 14-day soak (#238) the process
 * restarts; a seeder that wrote its neutral value on every boot would erase
 * every step `runDailyCycle` had made and leave the soak reporting a tuned
 * loop that in fact re-flattened itself daily — strictly worse than the empty
 * table this ticket started from. So the restart case is exercised the way it
 * actually happens: a SECOND `SqliteTuningStore` over the SAME database
 * handle, not a second call on the same object.
 */
import { SimulatedClock } from '../shared/index.js';
import { openSharedStore, type SharedStore } from '../shared/store/index.js';
import { seedAnalystWeights } from './seed-analyst-weights.js';
import { SqliteTuningStore } from './sqlite-tuning-store.js';
import type { TunableDial } from './types.js';

const START = new Date('2026-08-05T09:00:00.000Z');

/** The paper profile's band (paper-profile.ts): floor 0.5, ceiling 1.5 — midpoint 1.0. */
const BAND: TunableDial = {
  max_step: 0.05,
  floor: 0.5,
  ceiling: 1.5,
  tighten_is: 'decrease',
};

function openStore(db: SharedStore): SqliteTuningStore {
  return new SqliteTuningStore(db, new SimulatedClock(START));
}

describe('seedAnalystWeights', () => {
  let db: SharedStore;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  it('writes a neutral row for every analyst on a fresh store', () => {
    const tuning = openStore(db);

    const result = seedAnalystWeights({
      tuning,
      analyst_ids: ['technical', 'fundamental', 'sentiment'],
      dial: BAND,
    });

    expect(tuning.getAnalystWeights()).toEqual({
      technical: 1,
      fundamental: 1,
      sentiment: 1,
    });
    expect(result).toEqual({ seeded: ['technical', 'fundamental', 'sentiment'], existing: [] });
  });

  /**
   * The band's MIDPOINT, not a hard-coded 1.0: `impliedWeight` targets
   * `midpoint + halfBand * tanh(meanCredit)`, so the midpoint is the only
   * value an analyst with no evidence either way is not immediately pulled
   * away from. Re-centring the band must move the seed with it.
   */
  it('seeds the band midpoint, not a hard-coded 1.0', () => {
    const tuning = openStore(db);

    seedAnalystWeights({
      tuning,
      analyst_ids: ['technical'],
      dial: { ...BAND, floor: 1, ceiling: 3 },
    });

    expect(tuning.getAnalystWeights()).toEqual({ technical: 2 });
  });

  it('leaves a tuned weight alone across a restart', () => {
    seedAnalystWeights({
      tuning: openStore(db),
      analyst_ids: ['technical', 'sentiment'],
      dial: BAND,
    });

    // A daily cycle steps one of them, exactly as `runDailyCycle` would.
    openStore(db).setAnalystWeight('technical', 1.25);

    // Restart: a brand-new store object over the same database.
    const result = seedAnalystWeights({
      tuning: openStore(db),
      analyst_ids: ['technical', 'sentiment'],
      dial: BAND,
    });

    expect(openStore(db).getAnalystWeights()).toEqual({ technical: 1.25, sentiment: 1 });
    expect(result).toEqual({ seeded: [], existing: ['technical', 'sentiment'] });
  });

  it('seeds only the analyst a later release added, leaving the tuned ones untouched', () => {
    const tuning = openStore(db);
    seedAnalystWeights({ tuning, analyst_ids: ['technical'], dial: BAND });
    tuning.setAnalystWeight('technical', 0.75);

    const result = seedAnalystWeights({
      tuning: openStore(db),
      analyst_ids: ['technical', 'sentiment'],
      dial: BAND,
    });

    expect(openStore(db).getAnalystWeights()).toEqual({ technical: 0.75, sentiment: 1 });
    expect(result).toEqual({ seeded: ['sentiment'], existing: ['technical'] });
  });

  /**
   * A weight tuned to the band midpoint is indistinguishable from a seeded
   * one BY VALUE — so the seeder must key on row presence, never on "does it
   * still look neutral". Otherwise an analyst that legitimately tuned back to
   * 1.0 would have its `updated_at` rewritten every boot, corrupting the only
   * record of when the loop last moved it.
   */
  it('does not rewrite a row whose value happens to equal the midpoint', () => {
    seedAnalystWeights({ tuning: openStore(db), analyst_ids: ['technical'], dial: BAND });

    const stamped = new SqliteTuningStore(db, new SimulatedClock(new Date('2026-08-06T09:00:00Z')));
    seedAnalystWeights({ tuning: stamped, analyst_ids: ['technical'], dial: BAND });

    const row = db
      .prepare('SELECT updated_at FROM analyst_weights WHERE analyst_id = ?')
      .get('technical') as { updated_at: string };
    expect(row.updated_at).toBe(START.toISOString());
  });

  it('ignores a duplicate analyst id rather than reporting it twice', () => {
    const tuning = openStore(db);

    const result = seedAnalystWeights({
      tuning,
      analyst_ids: ['technical', 'technical'],
      dial: BAND,
    });

    expect(result).toEqual({ seeded: ['technical'], existing: [] });
    expect(tuning.getAnalystWeights()).toEqual({ technical: 1 });
  });

  it('is a no-op when the composition root builds no analysts', () => {
    const tuning = openStore(db);

    expect(seedAnalystWeights({ tuning, analyst_ids: [], dial: BAND })).toEqual({
      seeded: [],
      existing: [],
    });
    expect(tuning.getAnalystWeights()).toEqual({});
  });
});
