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
import type { TuningStore } from '../shared/index.js';
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

  /**
   * The concurrency case, not the sequential-restart one (PR #376 review).
   *
   * Two processes overlap across a restart — the old one still finishing, the
   * new one booting — and both look at `analyst_weights` before either has
   * written. A caller-side "read the map, then write the gaps" is idempotent
   * only under a single serialized boot: with a read that predates the other
   * process's tune, the seeder would write its neutral value over a weight
   * the loop had already moved, silently and to a value indistinguishable
   * from a healthy seed.
   *
   * `StaleReadTuningStore` is that interleaving, made deterministic: reads
   * answer from a snapshot taken BEFORE the concurrent boot seeded and tuned,
   * while writes go to the real database. The only thing that can save the
   * tuned weight here is the write itself refusing.
   */
  it('cannot clobber a tuned weight through a stale read of the table', () => {
    /** Reads from a pre-tune snapshot; every write goes to the live store. */
    class StaleReadTuningStore implements TuningStore {
      constructor(
        private readonly live: SqliteTuningStore,
        private readonly snapshot: Record<string, number>,
      ) {}
      getAnalystWeights(): Record<string, number> {
        return { ...this.snapshot };
      }
      setAnalystWeight(analyst_id: string, weight: number): void {
        this.live.setAnalystWeight(analyst_id, weight);
      }
      seedAnalystWeight(analyst_id: string, weight: number): boolean {
        return this.live.seedAnalystWeight(analyst_id, weight);
      }
      getStrategyParams(): Record<string, number> {
        return this.live.getStrategyParams();
      }
      setStrategyParam(name: string, value: number): void {
        this.live.setStrategyParam(name, value);
      }
      getRiskThresholds(): Record<string, number> {
        return this.live.getRiskThresholds();
      }
      setRiskThreshold(name: string, value: number): void {
        this.live.setRiskThreshold(name, value);
      }
      seedRiskThreshold(name: string, value: number): boolean {
        return this.live.seedRiskThreshold(name, value);
      }
    }

    const live = openStore(db);
    // What the second process saw when it looked: an empty table.
    const staleSnapshot = live.getAnalystWeights();
    expect(staleSnapshot).toEqual({});

    // Meanwhile the first process seeds and its cycle tunes.
    seedAnalystWeights({ tuning: live, analyst_ids: ['technical'], dial: BAND });
    live.setAnalystWeight('technical', 1.25);

    // The second process now writes, still believing the table is empty.
    const result = seedAnalystWeights({
      tuning: new StaleReadTuningStore(live, staleSnapshot),
      analyst_ids: ['technical'],
      dial: BAND,
    });

    expect(live.getAnalystWeights()).toEqual({ technical: 1.25 });
    expect(result).toEqual({ seeded: [], existing: ['technical'] });
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
