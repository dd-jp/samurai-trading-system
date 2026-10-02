import { describe, expect, it, vi } from 'vitest';
import type { HeartbeatOutcome } from '../heartbeat.js';
import {
  SIGNALS_BEAT_EVERY_MS,
  SIGNALS_FAIL_AFTER,
  SIGNALS_PASS_STUCK_MS,
  SignalsLiveness,
} from './liveness.js';

function harness() {
  let now = 1_000_000;
  let passAge: number | undefined;
  const pings: HeartbeatOutcome[] = [];
  const heartbeat = vi.fn((outcome: HeartbeatOutcome) => {
    pings.push(outcome);
    return Promise.resolve();
  });
  const liveness = new SignalsLiveness(
    heartbeat,
    () => now,
    () => passAge,
  );
  return {
    liveness,
    pings,
    advance: (ms: number) => {
      now += ms;
    },
    setPassAge: (age: number | undefined) => {
      passAge = age;
    },
  };
}

function failPasses(liveness: SignalsLiveness, count: number): void {
  for (let i = 0; i < count; i += 1) liveness.passFinished(false);
}

describe('SignalsLiveness', () => {
  it('sends no success ping inside the first interval after boot, so a crash loop stays silent', () => {
    const { liveness, pings, advance } = harness();
    liveness.beat();
    advance(SIGNALS_BEAT_EVERY_MS - 1);
    liveness.beat();
    expect(pings).toEqual([]);
  });

  it('pings success once the interval has passed, then at most once per interval', () => {
    const { liveness, pings, advance } = harness();
    advance(SIGNALS_BEAT_EVERY_MS);
    liveness.beat();
    advance(30_000);
    liveness.beat();
    advance(SIGNALS_BEAT_EVERY_MS - 30_001);
    liveness.beat();
    expect(pings).toEqual(['success']);
    advance(1);
    liveness.beat();
    expect(pings).toEqual(['success', 'success']);
  });

  it('pings fail on the fifth failed pass in a row, and not on the fourth or sixth', () => {
    const { liveness, pings } = harness();
    failPasses(liveness, SIGNALS_FAIL_AFTER - 1);
    expect(pings).toEqual([]);
    failPasses(liveness, 1);
    expect(pings).toEqual(['fail']);
    failPasses(liveness, 1);
    expect(pings).toEqual(['fail']);
  });

  it('counts only consecutive failures: a good pass resets the run', () => {
    const { liveness, pings } = harness();
    failPasses(liveness, SIGNALS_FAIL_AFTER - 1);
    liveness.passFinished(true);
    failPasses(liveness, SIGNALS_FAIL_AFTER - 1);
    expect(pings).toEqual([]);
  });

  it('stops success pings while the fail run holds, and resumes after a good pass', () => {
    const { liveness, pings, advance } = harness();
    failPasses(liveness, SIGNALS_FAIL_AFTER);
    advance(SIGNALS_BEAT_EVERY_MS);
    liveness.beat();
    expect(pings).toEqual(['fail']);
    liveness.passFinished(true);
    liveness.beat();
    expect(pings).toEqual(['fail', 'success']);
  });

  it('holds the success ping while one pass has been open longer than the bound, and pings at the bound', () => {
    const { liveness, pings, advance, setPassAge } = harness();
    advance(SIGNALS_BEAT_EVERY_MS);
    setPassAge(SIGNALS_PASS_STUCK_MS + 1);
    liveness.beat();
    expect(pings).toEqual([]);
    setPassAge(SIGNALS_PASS_STUCK_MS);
    liveness.beat();
    expect(pings).toEqual(['success']);
  });

  it('resumes the success ping as soon as the stuck pass ends', () => {
    const { liveness, pings, advance, setPassAge } = harness();
    advance(SIGNALS_BEAT_EVERY_MS);
    setPassAge(SIGNALS_PASS_STUCK_MS + 1);
    liveness.beat();
    setPassAge(undefined);
    liveness.beat();
    expect(pings).toEqual(['success']);
  });

  it('swallows a rejecting heartbeat', async () => {
    let now = 0;
    const liveness = new SignalsLiveness(
      () => Promise.reject(new Error('down')),
      () => now,
      () => undefined,
    );
    now += SIGNALS_BEAT_EVERY_MS;
    liveness.beat();
    failPasses(liveness, SIGNALS_FAIL_AFTER);
    await new Promise((resolve) => setImmediate(resolve));
  });
});
