import { describe, expect, it } from 'vitest';
import { DEBATE_BAR_TIMEFRAME_MS } from '../../pipeline/debate-engine/index.js';
import {
  DEFAULT_MAX_DECISION_RETRIES_PER_BAR,
  DebateBarDecisionGate,
} from './decision-bar-gate.js';

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

    const result = gate.rescind('BTC-USD', claimed as NonNullable<typeof claimed>);
    expect(result).toBe('retried');

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

    const result = gate.rescind('BTC-USD', old as NonNullable<typeof old>);
    expect(result).toBe('stale');

    // The new bar's claim must still hold — a second decision in 15:00's bar
    // would be exactly the duplicate the gate exists to make inexpressible.
    expect(gate.claim('BTC-USD', new Date('2026-08-12T15:04:00Z'))).toBeUndefined();
  });

  // ── The retry bound (#785). ─────────────────────────────────────────────
  describe('retry bound', () => {
    it('rejects a non-positive retry budget at construction', () => {
      expect(() => new DebateBarDecisionGate(0)).toThrow(/maxRetriesPerBar/);
      expect(() => new DebateBarDecisionGate(-1)).toThrow(/maxRetriesPerBar/);
      expect(() => new DebateBarDecisionGate(Number.NaN)).toThrow(/maxRetriesPerBar/);
    });

    it('retries up to the budget, then forfeits — the claim is KEPT, not released, on forfeit', () => {
      const maxRetries = 3;
      const gate = new DebateBarDecisionGate(maxRetries);
      const claimed = gate.claim('BTC-USD', MID_BAR) as NonNullable<ReturnType<typeof gate.claim>>;

      // Retries 1..maxRetries-1 are ordinary: released, and the bar is
      // reclaimable on the very next tick.
      for (let i = 1; i < maxRetries; i++) {
        expect(gate.rescind('BTC-USD', claimed)).toBe('retried');
        const reclaimed = gate.claim('BTC-USD', new Date(MID_BAR.getTime() + i * 60_000));
        expect(reclaimed).toBeDefined();
        expect(reclaimed?.open_time).toEqual(BAR_OPEN);
      }

      // The budget-th rescind forfeits: the claim is KEPT, so the SAME bar
      // refuses every further claim for the rest of its life — the tick
      // path only, no more decision-pass retries.
      const result = gate.rescind('BTC-USD', claimed);
      expect(result).toBe('forfeited');
      expect(gate.claim('BTC-USD', new Date(MID_BAR.getTime() + 10 * 60_000))).toBeUndefined();
      expect(gate.claim('BTC-USD', new Date(BAR_OPEN.getTime() + 59 * 60_000))).toBeUndefined();
    });

    it('a forfeited bar does not poison the NEXT bar — claim resets the retry count', () => {
      const gate = new DebateBarDecisionGate(1); // forfeits on the FIRST rescind
      const claimed = gate.claim('BTC-USD', MID_BAR) as NonNullable<ReturnType<typeof gate.claim>>;
      expect(gate.rescind('BTC-USD', claimed)).toBe('forfeited');
      expect(gate.claim('BTC-USD', new Date(MID_BAR.getTime() + 5 * 60_000))).toBeUndefined();

      // The next bar opens with a fresh claim and a fresh budget — a
      // forfeit does not carry over.
      const nextClaim = gate.claim('BTC-USD', NEXT_BAR_OPEN);
      expect(nextClaim).toBeDefined();
      expect(nextClaim?.open_time).toEqual(NEXT_BAR_OPEN);
      // With a budget of 1, the new bar's own first rescind ALSO forfeits —
      // the point is that it forfeits on its OWN first attempt (a fresh
      // count), not that it inherited zero budget from the last bar's
      // exhaustion (which would forfeit with no rescind at all).
      expect(gate.rescind('BTC-USD', nextClaim as NonNullable<typeof nextClaim>)).toBe('forfeited');
    });

    it('a fresh bar starts with the FULL budget again — no carry-over debt from a prior forfeit', () => {
      const gate = new DebateBarDecisionGate(2);
      const claimed = gate.claim('BTC-USD', MID_BAR) as NonNullable<ReturnType<typeof gate.claim>>;
      expect(gate.rescind('BTC-USD', claimed)).toBe('retried');
      const reclaimed = gate.claim('BTC-USD', new Date(MID_BAR.getTime() + 60_000)) as NonNullable<
        ReturnType<typeof gate.claim>
      >;
      expect(gate.rescind('BTC-USD', reclaimed)).toBe('forfeited');

      // The next bar's FIRST rescind is 'retried', not 'forfeited' — it gets
      // the full budget of 2, not a budget already spent by the prior bar.
      const nextClaim = gate.claim('BTC-USD', NEXT_BAR_OPEN) as NonNullable<
        ReturnType<typeof gate.claim>
      >;
      expect(gate.rescind('BTC-USD', nextClaim)).toBe('retried');
    });

    it('one instrument forfeiting does not affect another instrument in the same bar', () => {
      const gate = new DebateBarDecisionGate(1);
      const btc = gate.claim('BTC-USD', MID_BAR) as NonNullable<ReturnType<typeof gate.claim>>;
      const eth = gate.claim('ETH-USD', MID_BAR) as NonNullable<ReturnType<typeof gate.claim>>;

      expect(gate.rescind('BTC-USD', btc)).toBe('forfeited');
      expect(gate.claim('BTC-USD', new Date(MID_BAR.getTime() + 60_000))).toBeUndefined();

      // ETH-USD's own claim/rescind cycle is untouched by BTC-USD's forfeit.
      expect(gate.rescind('ETH-USD', eth)).toBe('forfeited');
      expect(gate.claim('ETH-USD', new Date(MID_BAR.getTime() + 60_000))).toBeUndefined();
    });

    it('the default retry budget is a positive finite number', () => {
      expect(DEFAULT_MAX_DECISION_RETRIES_PER_BAR).toBeGreaterThan(0);
      expect(Number.isFinite(DEFAULT_MAX_DECISION_RETRIES_PER_BAR)).toBe(true);
    });
  });
});
