import { describe, expect, it } from 'vitest';
import { DEBATE_BAR_TIMEFRAME_MS } from '../../pipeline/debate-engine/index.js';
import { DebateBarDecisionGate } from './decision-bar-gate.js';

const BAR_OPEN = new Date('2026-08-12T14:00:00Z');
const MID_BAR = new Date('2026-08-12T14:32:00Z');
const NEXT_BAR_OPEN = new Date('2026-08-12T15:00:00Z');

describe('DebateBarDecisionGate', () => {
  it('grants exactly one claim per instrument per bar, at any tick inside it', () => {
    const gate = new DebateBarDecisionGate();

    const first = gate.claim('BTC-USD', new Date('2026-08-12T14:02:00Z'));
    expect(first).toBeDefined();
    expect(first?.open_time).toEqual(BAR_OPEN);
    expect(first?.timeframe_ms).toBe(DEBATE_BAR_TIMEFRAME_MS);
    expect(first?.id).toBe(`${BAR_OPEN.toISOString()}@${DEBATE_BAR_TIMEFRAME_MS}`);

    // Every later tick in the same bar — 29 of them at the 2-minute cadence —
    // is refused: this refusal IS the tick path.
    for (let tick = 4; tick < 60; tick += 2) {
      expect(gate.claim('BTC-USD', new Date(BAR_OPEN.getTime() + tick * 60_000))).toBeUndefined();
    }
  });

  it('opens again on the next bar', () => {
    const gate = new DebateBarDecisionGate();
    expect(gate.claim('BTC-USD', MID_BAR)).toBeDefined();

    const next = gate.claim('BTC-USD', new Date('2026-08-12T15:00:30Z'));
    expect(next?.open_time).toEqual(NEXT_BAR_OPEN);
  });

  it('claims per instrument — one instrument cannot exhaust the bar for another', () => {
    const gate = new DebateBarDecisionGate();
    expect(gate.claim('BTC-USD', MID_BAR)).toBeDefined();
    expect(gate.claim('ETH-USD', MID_BAR)).toBeDefined();
    expect(gate.claim('ETH-USD', MID_BAR)).toBeUndefined();
  });

  it('rescind restores the claim for the same bar — the crash-retry path', () => {
    const gate = new DebateBarDecisionGate();
    const claimed = gate.claim('BTC-USD', MID_BAR);
    expect(claimed).toBeDefined();
    expect(gate.claim('BTC-USD', MID_BAR)).toBeUndefined();

    gate.rescind('BTC-USD', claimed as NonNullable<typeof claimed>);

    // The next tick in the bar retries the decision instead of the bar being
    // silently forfeited to a transient failure.
    const retried = gate.claim('BTC-USD', new Date('2026-08-12T14:34:00Z'));
    expect(retried?.open_time).toEqual(BAR_OPEN);
  });

  it('a stale rescind cannot unlock a NEWER bar claim (ownership-aware)', () => {
    const gate = new DebateBarDecisionGate();
    const old = gate.claim('BTC-USD', MID_BAR);
    expect(old).toBeDefined();

    // The next bar opens and is claimed; only THEN does the old bar's failed
    // pass get around to rescinding (a slow catch handler racing the clock).
    const next = gate.claim('BTC-USD', new Date('2026-08-12T15:02:00Z'));
    expect(next).toBeDefined();

    gate.rescind('BTC-USD', old as NonNullable<typeof old>);

    // The new bar's claim must still hold — a second decision in 15:00's bar
    // would be exactly the duplicate the gate exists to make inexpressible.
    expect(gate.claim('BTC-USD', new Date('2026-08-12T15:04:00Z'))).toBeUndefined();
  });
});
