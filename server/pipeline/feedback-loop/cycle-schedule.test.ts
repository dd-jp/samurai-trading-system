import { currentBoundary, isBoundaryDue, nextBoundary } from './cycle-schedule.js';

describe('currentBoundary', () => {
  it('floors an exact-boundary instant to itself', () => {
    const midnight = new Date('2026-08-01T00:00:00.000Z');
    expect(currentBoundary(midnight, 24 * 60 * 60 * 1_000)).toEqual(midnight);
  });

  it('floors an instant mid-interval down to the last completed boundary', () => {
    const midday = new Date('2026-08-01T12:00:00.000Z');
    expect(currentBoundary(midday, 24 * 60 * 60 * 1_000)).toEqual(
      new Date('2026-08-01T00:00:00.000Z'),
    );
  });

  it('is epoch-anchored, not anchored to an arbitrary process start time — two different restarts a day apart land on the same phase', () => {
    // Two instants a day apart both floor to a UTC midnight, without either
    // one being handed in as a reference point. An interval anchored to
    // "when the process booted" could not do this: it would need that boot
    // instant as an extra argument, and every restart would shift the phase
    const day1 = new Date('2026-08-01T09:00:00.000Z');
    const day2 = new Date('2026-08-02T09:00:00.000Z');
    const DAY_MS = 24 * 60 * 60 * 1_000;
    expect(currentBoundary(day1, DAY_MS)).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(currentBoundary(day2, DAY_MS)).toEqual(new Date('2026-08-02T00:00:00.000Z'));
  });

  it('throws on a non-positive interval rather than dividing by zero or looping forever', () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    expect(() => currentBoundary(now, 0)).toThrow(/intervalMs must be positive/);
    expect(() => currentBoundary(now, -1)).toThrow(/intervalMs must be positive/);
  });
});

describe('nextBoundary', () => {
  it('is exactly one interval after currentBoundary, not one interval after `now`', () => {
    // `now` is 1ms before the boundary that closes at `midnight` — one
    // interval after THAT boundary, not one interval after `now` itself,
    // which is the distinction that makes catch-up land on the boundary
    // just missed rather than drifting a few ms into the next one
    const now = new Date('2026-08-01T23:59:59.999Z');
    const DAY_MS = 24 * 60 * 60 * 1_000;
    expect(nextBoundary(now, DAY_MS)).toEqual(new Date('2026-08-02T00:00:00.000Z'));
  });

  it('at an exact boundary, is one full interval ahead — not the same instant', () => {
    const midnight = new Date('2026-08-01T00:00:00.000Z');
    const DAY_MS = 24 * 60 * 60 * 1_000;
    expect(nextBoundary(midnight, DAY_MS)).toEqual(new Date('2026-08-02T00:00:00.000Z'));
  });
});

describe('isBoundaryDue', () => {
  it('is due when nothing has ever completed', () => {
    const boundary = new Date('2026-08-01T00:00:00.000Z');
    expect(isBoundaryDue(boundary, null)).toBe(true);
  });

  it('is due when the boundary is strictly after the last completed one', () => {
    const last = new Date('2026-08-01T00:00:00.000Z');
    const boundary = new Date('2026-08-02T00:00:00.000Z');
    expect(isBoundaryDue(boundary, last)).toBe(true);
  });

  it('is not due when the boundary already equals the last completed one', () => {
    const same = new Date('2026-08-01T00:00:00.000Z');
    expect(isBoundaryDue(same, same)).toBe(false);
  });

  it('is not due when the boundary is before the last completed one', () => {
    const last = new Date('2026-08-02T00:00:00.000Z');
    const boundary = new Date('2026-08-01T00:00:00.000Z');
    expect(isBoundaryDue(boundary, last)).toBe(false);
  });
});
