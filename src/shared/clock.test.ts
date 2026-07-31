import { SimulatedClock, SystemClock } from './clock.js';

describe('SystemClock', () => {
  it('returns a Date close to real time', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const now = clock.now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});

describe('SimulatedClock', () => {
  const start = new Date('2024-01-02T00:00:00.000Z');

  it('reports the instant it was constructed at', () => {
    expect(new SimulatedClock(start).now()).toEqual(start);
  });

  it('reports the new instant after a step', () => {
    const clock = new SimulatedClock(start);
    const next = new Date('2024-01-02T00:01:00.000Z');

    clock.advanceTo(next);

    expect(clock.now()).toEqual(next);
  });

  it('does not move when the caller mutates a returned Date', () => {
    const clock = new SimulatedClock(start);

    clock.now().setFullYear(2030);

    expect(clock.now()).toEqual(start);
  });

  it('does not move when the caller mutates the start Date', () => {
    const mutableStart = new Date(start);
    const clock = new SimulatedClock(mutableStart);

    mutableStart.setFullYear(2030);

    expect(clock.now()).toEqual(start);
  });

  it('allows re-advancing to the current instant as a no-op', () => {
    const clock = new SimulatedClock(start);

    clock.advanceTo(new Date(start));

    expect(clock.now()).toEqual(start);
  });

  it('throws rather than stepping backwards', () => {
    const clock = new SimulatedClock(start);

    expect(() => clock.advanceTo(new Date('2024-01-01T23:59:59.000Z'))).toThrow(
      /refusing to step backwards/,
    );
    expect(clock.now()).toEqual(start);
  });
});
