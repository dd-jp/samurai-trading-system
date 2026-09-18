import type { TuningStore } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../shared/store/index.js';
import { seedAnalystWeights } from './seed-analyst-weights.js';
import { SqliteTuningStore } from './sqlite-tuning-store.js';
import type { TunableDial } from './types.js';

const START = new Date('2026-08-05T09:00:00.000Z');

const BAND: TunableDial = {
  max_step: 0.05,
  floor: 0.5,
  ceiling: 1.5,
  tighten_is: 'decrease',
};

function openStore(db: StoreHandle): SqliteTuningStore {
  return new SqliteTuningStore(db, new SimulatedClock(START));
}

describe('seedAnalystWeights', () => {
  let db: StoreHandle;

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

    openStore(db).setAnalystWeight('technical', 1.25);

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

  it('does not rewrite a row whose value happens to equal the midpoint', () => {
    seedAnalystWeights({ tuning: openStore(db), analyst_ids: ['technical'], dial: BAND });

    const stamped = new SqliteTuningStore(db, new SimulatedClock(new Date('2026-08-06T09:00:00Z')));
    seedAnalystWeights({ tuning: stamped, analyst_ids: ['technical'], dial: BAND });

    const row = db
      .prepare('SELECT updated_at FROM analyst_weights WHERE analyst_id = ?')
      .get('technical') as { updated_at: string };
    expect(row.updated_at).toBe(START.toISOString());
  });

  it('cannot clobber a tuned weight through a stale read of the table', () => {
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
    const staleSnapshot = live.getAnalystWeights();
    expect(staleSnapshot).toEqual({});

    seedAnalystWeights({ tuning: live, analyst_ids: ['technical'], dial: BAND });
    live.setAnalystWeight('technical', 1.25);

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
