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

  describe('attemptedBoundary / recordAttempt', () => {
    it('reports no attempt yet for a virgin store', () => {
      const db = openSharedStore(':memory:');
      const store = new SqliteFeedbackCycleScheduleStore(db);

      expect(store.attemptedBoundary()).toBeNull();
    });

    it('round-trips a recorded attempt, independently of lastBoundary', () => {
      const db = openSharedStore(':memory:');
      const store = new SqliteFeedbackCycleScheduleStore(db);
      const boundary = new Date('2026-08-01T00:00:00.000Z');

      store.recordAttempt(boundary, new Date('2026-08-01T00:00:00.400Z'));

      expect(store.attemptedBoundary()).toEqual(boundary);
      expect(store.lastBoundary()).toBeNull();
    });

    it('recording completion does not erase, or require, a prior attempt', () => {
      const db = openSharedStore(':memory:');
      const store = new SqliteFeedbackCycleScheduleStore(db);
      const boundary = new Date('2026-08-01T00:00:00.000Z');

      store.recordBoundary(boundary, new Date('2026-08-01T00:00:00.400Z'));

      expect(store.lastBoundary()).toEqual(boundary);
      expect(store.attemptedBoundary()).toBeNull();
    });

    it('refuses to step the recorded attempt backwards, same as recordBoundary', () => {
      const db = openSharedStore(':memory:');
      const store = new SqliteFeedbackCycleScheduleStore(db);

      store.recordAttempt(
        new Date('2026-08-02T00:00:00.000Z'),
        new Date('2026-08-02T00:00:00.400Z'),
      );
      store.recordAttempt(
        new Date('2026-08-01T00:00:00.000Z'),
        new Date('2026-08-01T00:00:00.400Z'),
      );

      expect(store.attemptedBoundary()).toEqual(new Date('2026-08-02T00:00:00.000Z'));
    });

    it('an attempt and a completion for the same boundary live as two rows', () => {
      const db = openSharedStore(':memory:');
      const store = new SqliteFeedbackCycleScheduleStore(db);
      const boundary = new Date('2026-08-01T00:00:00.000Z');

      store.recordAttempt(boundary, new Date('2026-08-01T00:00:00.400Z'));
      store.recordBoundary(boundary, new Date('2026-08-01T00:00:00.500Z'));

      expect(db.prepare('SELECT COUNT(*) AS n FROM feedback_cycle_schedule').get()).toEqual({
        n: 2,
      });
      expect(store.attemptedBoundary()).toEqual(boundary);
      expect(store.lastBoundary()).toEqual(boundary);
    });
  });
});
