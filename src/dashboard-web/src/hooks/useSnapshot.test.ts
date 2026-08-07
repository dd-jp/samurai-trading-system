/**
 * The fetch boundary's validation (PR #597 review). `toWireSnapshot` is the
 * ONE place a payload off the network is checked and `mode` is narrowed, so
 * every consumer downstream can read `snapshot.mode` and trust it.
 *
 * Pure — no DOM, no fetch, no timers. The polling behaviour around it is
 * covered by the component tests in `App.test.tsx`.
 */
import { describe, expect, it } from 'vitest';
import { makeSnapshot } from '../test-fixtures.ts';
import { RECOGNISED_MODES, toWireSnapshot } from './useSnapshot.ts';

/** A payload as it comes off `response.json()`: untyped, possibly wrong. */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(makeSnapshot() as unknown as Record<string, unknown>), ...overrides };
}

describe('toWireSnapshot', () => {
  it.each(RECOGNISED_MODES)('passes the recognised mode %s through', (mode) => {
    expect(toWireSnapshot(raw({ mode }))?.mode).toBe(mode);
  });

  it('narrows an ABSENT mode to null rather than leaving it undefined', () => {
    const body = raw();
    delete body.mode;
    const snapshot = toWireSnapshot(body);

    // Not `undefined`: the type says `ServerMode | null`, and a consumer that
    // reads this field must find the value the type promises.
    expect(snapshot?.mode).toBeNull();
  });

  it.each([
    ['staging'],
    [''],
    ['PAPER'],
    [' live'],
    [42],
    [null],
    [{ mode: 'live' }],
  ])('narrows the unrecognised mode %o to null', (mode) => {
    expect(toWireSnapshot(raw({ mode }))?.mode).toBeNull();
  });

  it('never coerces an unknown mode toward "paper"', () => {
    // The asymmetric failure this whole field exists to prevent: a page that
    // says "paper" while real money is at risk.
    for (const mode of [undefined, 'staging', 'live-ish', 0]) {
      expect(toWireSnapshot(raw({ mode }))?.mode).not.toBe('paper');
    }
  });

  it('keeps the rest of the payload when mode is unusable', () => {
    // A bad `mode` must not throw away positions, verdicts and the pipeline —
    // the strip has an honest rendering for an unknown mode, and blanking a
    // live-money screen over one field would be the worse failure.
    const body = raw({ mode: 'staging' });
    const snapshot = toWireSnapshot(body);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.positions.length).toBeGreaterThan(0);
    expect(snapshot?.verdicts.length).toBeGreaterThan(0);
    expect(snapshot?.pipeline).toBeDefined();
  });

  it('keeps the payload when the spend summary is null, and narrows it to null', () => {
    // #606 item 2: `SpendPanel` renders a named empty state for exactly this
    // value and the burn meter renders "meter not drawable", so rejecting the
    // body froze every OTHER panel — positions, verdicts, the whole pipeline —
    // to spare the one panel built to degrade.
    const snapshot = toWireSnapshot(raw({ llm_spend: null }));

    expect(snapshot).not.toBeNull();
    expect(snapshot?.llm_spend).toBeNull();
    expect(snapshot?.positions.length).toBeGreaterThan(0);
    expect(snapshot?.pipeline).toBeDefined();
  });

  it('narrows an ABSENT or non-object spend summary to null', () => {
    const absent = raw();
    delete absent.llm_spend;
    expect(toWireSnapshot(absent)?.llm_spend).toBeNull();
    // A scalar where an object belongs is the proxy/older-server case, and it
    // must not reach `SpendPanel` as something it will dereference.
    expect(toWireSnapshot(raw({ llm_spend: 'unavailable' }))?.llm_spend).toBeNull();
    expect(toWireSnapshot(raw({ llm_spend: 0 }))?.llm_spend).toBeNull();
  });

  it('narrows a spend summary the panel could not render to null', () => {
    // PR #607 review round 1: `typeof [] === 'object'`, so the first version of
    // this narrowing cast an array to `LlmSpendSummary` and `SpendPanel` threw
    // on `spend.all_time.per_debate` — a white screen, since `main.tsx` mounts
    // `<App/>` with no error boundary. Admitting a wrong shape is worse than
    // rejecting a null: the panel exists to say "the read failed", and it can
    // only say it if the boundary hands it `null`.
    const summary = makeSnapshot().llm_spend as unknown as Record<string, unknown>;
    const withoutAllTime = { ...summary };
    delete withoutAllTime.all_time;
    const windowWithoutPerDebate = { ...(summary.all_time as Record<string, unknown>) };
    delete windowWithoutPerDebate.per_debate;

    for (const spend of [
      [],
      [summary],
      withoutAllTime,
      { ...summary, all_time: windowWithoutPerDebate },
      { ...summary, last_7d: null },
      { ...summary, last_24h: [] },
      {},
    ]) {
      expect(toWireSnapshot(raw({ llm_spend: spend }))?.llm_spend).toBeNull();
    }
  });

  it('passes a real spend summary through untouched', () => {
    const body = raw();
    expect(toWireSnapshot(body)?.llm_spend).toEqual(body.llm_spend);
  });

  it('rejects a body that is not a snapshot at all', () => {
    expect(toWireSnapshot(null)).toBeNull();
    expect(toWireSnapshot('<html>captive portal</html>')).toBeNull();
    expect(toWireSnapshot({})).toBeNull();
    // Parses, has a mode, but carries no pipeline lanes — an empty theater
    // would read as "the system went quiet".
    const body = raw();
    delete body.pipeline;
    expect(toWireSnapshot(body)).toBeNull();
  });
});
