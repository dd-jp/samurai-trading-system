import { openSharedStore } from '../../shared/store/index.js';
import { SqliteFeedbackCycleScheduleStore } from './sqlite-feedback-cycle-schedule-store.js';

describe('SqliteFeedbackCycleScheduleStore', () => {
  it('reports no boundary yet for a virgin store — the state a never-run cycle is in', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteFeedbackCycleScheduleStore(db);

    expect(store.lastBoundary()).toBeNull();
  });

  it('round-trips a recorded boundary', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteFeedbackCycleScheduleStore(db);
    const boundary = new Date('2026-08-01T00:00:00.000Z');

    store.recordBoundary(boundary, new Date('2026-08-01T00:00:00.400Z'));

    expect(store.lastBoundary()).toEqual(boundary);
  });

  it('a second recording overwrites the single row rather than appending', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteFeedbackCycleScheduleStore(db);

    store.recordBoundary(
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-08-01T00:00:00.400Z'),
    );
    store.recordBoundary(
      new Date('2026-08-02T00:00:00.000Z'),
      new Date('2026-08-02T00:00:00.400Z'),
    );

    expect(store.lastBoundary()).toEqual(new Date('2026-08-02T00:00:00.000Z'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback_cycle_schedule').get()).toEqual({ n: 1 });
  });

  /**
   * `MAX` in the write's own SQL, not a read-then-compare in application
   * code (see the class's own doc comment) — a write racing an
   * already-current row must not be able to step the schedule backwards.
   * Proven here by handing it a boundary OLDER than the one already stored.
   */
  it('refuses to step the recorded boundary backwards', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteFeedbackCycleScheduleStore(db);

    store.recordBoundary(
      new Date('2026-08-02T00:00:00.000Z'),
      new Date('2026-08-02T00:00:00.400Z'),
    );
    store.recordBoundary(
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-08-01T00:00:00.400Z'),
    );

    expect(store.lastBoundary()).toEqual(new Date('2026-08-02T00:00:00.000Z'));
  });
});
