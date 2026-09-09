/**
 * #1080. The four cases here are the whole point of the module: three degraded
 * paths that every resolved to the single word `neutral` in `audit_log`, and
 * the healthy path that must keep recording exactly what it recorded before.
 */
import type { DebateResult } from '../../pipeline/debate-engine/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { AnalystViewRelay, buildControlDebateStep } from './control-arm.js';
import { debateDecisionWord, isDegradedDecision } from './debate-decision.js';

const BAR = new Date('2026-09-03T14:00:00.000Z');

/** A converged debate. Every case below is this shape with one field changed. */
function resolvedDebate(overrides: Partial<DebateResult> = {}): DebateResult {
  return {
    synthesis: 'the panel converged',
    position: 'bullish: momentum intact',
    confidence: 0.71,
    contributions: [],
    disagreement_summary: '',
    open_items: [],
    converged: true,
    rounds_completed: 2,
    latency_ms: 21_400,
    direction: 'bullish',
    debate_id: 'debate-1',
    bar_timestamp: BAR,
    read: true,
    ...overrides,
  };
}

describe('debateDecisionWord', () => {
  it('records the direction of a debate that resolved on its own terms', () => {
    expect(debateDecisionWord(resolvedDebate())).toBe('bullish');
    expect(debateDecisionWord(resolvedDebate({ direction: 'neutral', confidence: 0.2 }))).toBe(
      'neutral',
    );
  });

  it('names a budget that fired before any round completed', () => {
    // `enforceLatencyBudget`'s LOW_CONFIDENCE_FALLBACK: neutral, zero
    // confidence, no rounds. This is the case that produced 22 of the 26
    // timed-out debates in the 2026-09-03 session, and the one that reads
    // identically to a genuine wash unless it is named.
    const starved = resolvedDebate({
      direction: 'neutral',
      confidence: 0,
      converged: false,
      rounds_completed: 0,
      timed_out: { budget_ms: 60_000, elapsed_ms: 60_002 },
    });

    expect(debateDecisionWord(starved)).toBe('budget_exhausted');
  });

  it('separates a truncated synthesis from an absent one', () => {
    // A round DID finish, so the direction is a real (if truncated) answer —
    // materially different from the case above, which has no answer at all.
    const partial = resolvedDebate({
      converged: false,
      rounds_completed: 1,
      timed_out: { budget_ms: 60_000, elapsed_ms: 60_001 },
    });

    expect(debateDecisionWord(partial)).toBe('timed_out_partial');
  });

  it('names a debate that was never admitted, ahead of any budget it never ran under', () => {
    const refused = resolvedDebate({
      direction: 'neutral',
      confidence: 0,
      converged: false,
      rounds_completed: 0,
      rate_limited: { reason: 'spend cap reached' },
    });

    expect(debateDecisionWord(refused)).toBe('not_admitted');
  });

  it('names a result marked unread ahead of its bare direction (#1393)', () => {
    // Synthetic: no producer sets `read: false` yet (see `DebateResult.read`'s
    // docblock). This is the orchestrator-side half of the same guard rail
    // `debateWasDegraded` (trader/decide.ts) enforces, pinned so the two
    // cannot silently disagree about the same result.
    const unread = resolvedDebate({
      direction: 'neutral',
      confidence: 0,
      converged: false,
      rounds_completed: 0,
      read: false,
    });

    expect(debateDecisionWord(unread)).toBe('unread');
    expect(isDegradedDecision(debateDecisionWord(unread))).toBe(true);
  });

  it('leaves the control arm writing its bare direction (#1080 AC6)', async () => {
    // The control arm runs a `debate` step like any other and its results reach
    // the same `record` call, so the comparability claim has to hold HERE, not
    // in prose. Its no-axis-vote branch is the adversarial case on purpose:
    // neutral, zero confidence, `rounds_completed: 0` — the exact shape of a
    // `budget_exhausted` fallback, minus the `timed_out` field that would make
    // it one. A classifier keying on the shape instead of the discriminator
    // would relabel the falsifier arm as broken and change what the comparison
    // measures.
    const relay = new AnalystViewRelay();
    const control = buildControlDebateStep(relay);

    const result = await control({
      trace_id: 'trace-1:control',
      instrument: 'QQQ',
      asset_class: 'stocks',
      views: [],
      clock: new SimulatedClock(BAR),
      bar: BAR,
    });

    expect(result.rounds_completed).toBe(0);
    expect(result.confidence).toBe(0);
    expect(debateDecisionWord(result)).toBe('neutral');
    expect(isDegradedDecision(debateDecisionWord(result))).toBe(false);
  });

  it('reports exactly the degraded words as degraded', () => {
    // The dashboard glosses on this predicate and the tick runner raises the
    // log level on it, so a direction leaking into it would recolour healthy
    // traffic as breakage.
    expect(isDegradedDecision('budget_exhausted')).toBe(true);
    expect(isDegradedDecision('timed_out_partial')).toBe(true);
    expect(isDegradedDecision('not_admitted')).toBe(true);
    expect(isDegradedDecision('unread')).toBe(true);
    expect(isDegradedDecision('bullish')).toBe(false);
    expect(isDegradedDecision('neutral')).toBe(false);
    expect(isDegradedDecision('quorum_skip')).toBe(false);
    expect(isDegradedDecision(null)).toBe(false);
  });
});
