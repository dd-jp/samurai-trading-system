import {
  buildDebateLog,
  buildDebateRoundLogRows,
  DEBATE_BAR_TIMEFRAME_MS,
  floorToBar,
  InMemoryDebateLogStore,
} from './debate-log-store.js';
import type { AnalystContribution, DebateResult } from './types.js';

function makeContribution(overrides: Partial<AnalystContribution> = {}): AnalystContribution {
  return {
    analyst_id: 'analyst-technical-1',
    analyst_type: 'technical',
    stance_during_debate: ['bullish', 'bullish'],
    final_position: 'bullish',
    rationale: 'Volume confirms breakout.',
    influence_score: 0.6,
    ...overrides,
  };
}

const BAR = new Date('2026-07-14T09:00:00Z');

function makeResult(overrides: Partial<DebateResult> = {}): DebateResult {
  return {
    synthesis: 'Bulls have the stronger case this bar.',
    position: 'Buy',
    confidence: 0.7,
    contributions: [makeContribution()],
    disagreement_summary: 'Bear cites overextension; bull cites volume confirmation.',
    open_items: [],
    converged: true,
    rounds_completed: 2,
    latency_ms: 8000,
    direction: 'bullish',
    debate_id: 'debate-1',
    bar_timestamp: BAR,
    read: true,
    ...overrides,
  };
}

describe('buildDebateLog', () => {
  it('projects a completed DebateResult into a DebateLog row', () => {
    const result = makeResult();
    const bar_timestamp = BAR;
    const created_at = new Date('2026-07-14T09:00:08Z');

    // #687: the bar is PROJECTED off the result, not passed in. A row can no
    // longer claim a bar coordinate its own `debate_id` does not encode.
    const log = buildDebateLog(result, 'BTC-USD', created_at);

    expect(log).toEqual({
      debate_id: 'debate-1',
      instrument: 'BTC-USD',
      bar_timestamp,
      contributions: result.contributions,
      direction: 'bullish',
      rounds: 2,
      created_at,
      // #617: what the Trader actually read, so a later same-bar tick can
      // replay this row instead of paying for an identical debate.
      confidence: result.confidence,
      synthesis: result.synthesis,
      position: result.position,
      disagreement_summary: result.disagreement_summary,
      open_items: result.open_items,
      converged: result.converged,
      // #1081: a completed, converged debate.
      termination: 'converged',
    });
  });

  it('#617 — carries confidence, the field position sizing is a function of', () => {
    // The whole replay path hinges on this one field: until migration 0026
    // `debate_log` had no column for it, so a persisted row could describe a
    // debate but never stand in for one.
    const log = buildDebateLog(
      makeResult({ confidence: 0.83 }),
      'BTC-USD',
      new Date('2026-07-14T09:00:08Z'),
    );

    expect(log.confidence).toBe(0.83);
  });
});

/**
 * #1081 — a debate truncated by the latency budget must be identifiable in
 * the stored record alone, and distinct from a debate that genuinely failed
 * to converge. Both land as `converged: false`; only `termination` tells them
 * apart.
 */
describe('buildDebateLog — termination (#1081)', () => {
  it('records latency_truncated for a debate the latency budget cut short', () => {
    const truncated = makeResult({
      converged: false,
      rounds_completed: 1,
      confidence: 0.219,
      // Set by `enforceLatencyBudget` exactly when it force-terminates a
      // debate before a result was produced — the one signal this migration
      // exists to not drop on the floor before persistence.
      timed_out: { budget_ms: 60_000, elapsed_ms: 60_003 },
    });

    const log = buildDebateLog(truncated, 'AAPL', new Date('2026-07-14T09:00:08Z'));

    expect(log.converged).toBe(false);
    expect(log.termination).toBe('latency_truncated');
  });

  it('records non_converged for a debate that genuinely failed to converge — no timeout', () => {
    const genuinelyDisagreed = makeResult({
      converged: false,
      rounds_completed: 3,
      confidence: 0.4,
      // No `timed_out` — this is the round-cap hybrid-termination path, not
      // the latency budget.
    });

    const log = buildDebateLog(genuinelyDisagreed, 'AAPL', new Date('2026-07-14T09:00:08Z'));

    expect(log.converged).toBe(false);
    expect(log.termination).toBe('non_converged');
  });

  it('a truncated debate and a genuinely non-converged debate produce different stored records', () => {
    const truncated = buildDebateLog(
      makeResult({
        debate_id: 'debate-truncated',
        converged: false,
        rounds_completed: 1,
        timed_out: { budget_ms: 60_000, elapsed_ms: 60_005 },
      }),
      'AAPL',
      new Date('2026-07-14T09:00:08Z'),
    );
    const genuinelyDisagreed = buildDebateLog(
      makeResult({
        debate_id: 'debate-disagreed',
        converged: false,
        rounds_completed: 3,
      }),
      'AAPL',
      new Date('2026-07-14T09:00:08Z'),
    );

    // Same `converged: false` — the pre-#1081 ambiguity this closes.
    expect(truncated.converged).toBe(genuinelyDisagreed.converged);
    // Different `termination` — the distinguishing signal.
    expect(truncated.termination).not.toBe(genuinelyDisagreed.termination);
    expect(truncated.termination).toBe('latency_truncated');
    expect(genuinelyDisagreed.termination).toBe('non_converged');
  });

  it('records converged for a debate the mediator actually converged', () => {
    const log = buildDebateLog(
      makeResult({ converged: true }),
      'AAPL',
      new Date('2026-07-14T09:00:08Z'),
    );

    expect(log.termination).toBe('converged');
  });
});

/**
 * `termination_cause` (#1380, migration 0051) splits `latency_truncated`
 * further: a genuine budget expiry from an LLM call that failed outright.
 * Both reuse the SAME `termination` value above — this column is the one a
 * query reads to tell them apart, not a new `termination` member.
 */
describe('buildDebateLog — termination_cause (#1380)', () => {
  it('carries "budget" onto a genuine latency-budget truncation', () => {
    const log = buildDebateLog(
      makeResult({
        converged: false,
        rounds_completed: 1,
        timed_out: { budget_ms: 60_000, elapsed_ms: 60_003, cause: 'budget' },
      }),
      'AAPL',
      new Date('2026-07-14T09:00:08Z'),
    );

    expect(log.termination).toBe('latency_truncated');
    expect(log.termination_cause).toBe('budget');
  });

  it('carries "llm_failure" onto a truncation caused by an outright LLM failure', () => {
    const log = buildDebateLog(
      makeResult({
        converged: false,
        rounds_completed: 1,
        timed_out: { budget_ms: 60_000, elapsed_ms: 42_000, cause: 'llm_failure' },
      }),
      'AAPL',
      new Date('2026-07-14T09:00:08Z'),
    );

    expect(log.termination).toBe('latency_truncated');
    expect(log.termination_cause).toBe('llm_failure');
  });

  it('is absent (not null, not a default) on a row with no timed_out at all', () => {
    const log = buildDebateLog(
      makeResult({ converged: false, rounds_completed: 3 }),
      'AAPL',
      new Date('2026-07-14T09:00:08Z'),
    );

    expect(log.termination).toBe('non_converged');
    expect(log.termination_cause).toBeUndefined();
  });

  it('is absent on a pre-#1380 timed_out fixture that carries no cause', () => {
    const log = buildDebateLog(
      makeResult({
        converged: false,
        rounds_completed: 1,
        timed_out: { budget_ms: 60_000, elapsed_ms: 60_003 },
      }),
      'AAPL',
      new Date('2026-07-14T09:00:08Z'),
    );

    expect(log.termination).toBe('latency_truncated');
    expect(log.termination_cause).toBeUndefined();
  });
});

describe('buildDebateRoundLogRows (#1517)', () => {
  it('projects each round_verdicts entry into a row keyed by debate_id', () => {
    const result = makeResult({
      round_verdicts: [
        { round: 1, direction: 'bearish', confidence: 0.3 },
        { round: 2, direction: 'bullish', confidence: 0.7 },
      ],
    });
    const created_at = new Date('2026-07-14T09:00:08Z');

    expect(buildDebateRoundLogRows(result, created_at)).toEqual([
      { debate_id: 'debate-1', round: 1, direction: 'bearish', confidence: 0.3, created_at },
      { debate_id: 'debate-1', round: 2, direction: 'bullish', confidence: 0.7, created_at },
    ]);
  });

  it('returns an empty array when the result carries no round_verdicts', () => {
    // No override: `makeResult`'s base object omits `round_verdicts` entirely
    // (absent, matching every real producer that predates #1517) rather than
    // setting it to `undefined` — `exactOptionalPropertyTypes` rejects the
    // latter as a `Partial<DebateResult>` override.
    const result = makeResult();
    expect(buildDebateRoundLogRows(result, new Date('2026-07-14T09:00:08Z'))).toEqual([]);
  });
});

describe('InMemoryDebateLogStore', () => {
  it('a completed debate: row exists and is joinable by debate_id', () => {
    const store = new InMemoryDebateLogStore();
    const result = makeResult();
    const log = buildDebateLog(result, 'BTC-USD', new Date('2026-07-14T09:00:08Z'));

    store.writeLog(log);

    expect(store.getByDebateId('debate-1')).toEqual(log);
  });

  it('a crashed/incomplete debate: no row is written, so lookup is absent', () => {
    const store = new InMemoryDebateLogStore();

    // Simulates decision #10: a crash discards in-flight round state before
    // the debate ever resolves, so `writeLog` (the "Debate log write" step,
    // which only runs after resolution) is never called for this debate_id.
    expect(store.getByDebateId('debate-never-completed')).toBeUndefined();
  });

  it('does not conflate rows across distinct debate_ids', () => {
    const store = new InMemoryDebateLogStore();
    const first = buildDebateLog(
      makeResult({ debate_id: 'debate-1' }),
      'BTC-USD',
      new Date('2026-07-14T09:00:08Z'),
    );
    const second = buildDebateLog(
      makeResult({
        debate_id: 'debate-2',
        direction: 'bearish',
        bar_timestamp: new Date('2026-07-14T09:05:00Z'),
      }),
      'ETH-USD',
      new Date('2026-07-14T09:05:07Z'),
    );

    store.writeLog(first);
    store.writeLog(second);

    expect(store.getByDebateId('debate-1')).toEqual(first);
    expect(store.getByDebateId('debate-2')).toEqual(second);
  });

  it('writeLogWithRounds writes the log, readable by getByDebateId, and discards rounds without throwing (#1558 review) — writeRoundLog is off this store now, no reader exists on this port', () => {
    const store = new InMemoryDebateLogStore();
    const result = makeResult({
      round_verdicts: [{ round: 1, direction: 'bullish', confidence: 0.5 }],
    });
    const created_at = new Date('2026-07-14T09:00:08Z');
    const log = buildDebateLog(result, 'BTC-USD', created_at);

    expect(() =>
      store.writeLogWithRounds(log, buildDebateRoundLogRows(result, created_at)),
    ).not.toThrow();
    expect(store.getByDebateId(log.debate_id)).toEqual(log);
  });
});

/**
 * #393 — `bar_timestamp` used to hold `clock.now()` unfloored, which is what
 * `created_at` already means. A replay stepping bars advances the clock TO a
 * bar close, so it would look up 14:30:00 and miss a live row stamped
 * 14:32:07 — and replay-from-log is the determinism posture ADR-0003 §2
 * states for every LLM pass.
 */
describe('floorToBar', () => {
  it('floors a mid-bar instant to the bar it belongs to', () => {
    expect(floorToBar(new Date('2026-08-06T14:32:07.412Z'))).toEqual(
      new Date('2026-08-06T14:00:00.000Z'),
    );
  });

  it('leaves an instant already on a boundary alone', () => {
    // The replay case: a deterministic replay advances the clock TO the bar close,
    // so flooring must be the identity there or live and replay would still
    // disagree.
    const onBar = new Date('2026-08-06T14:00:00.000Z');
    expect(floorToBar(onBar)).toEqual(onBar);
  });

  it('is idempotent', () => {
    const once = floorToBar(new Date('2026-08-06T14:59:59.999Z'));
    expect(floorToBar(once)).toEqual(once);
  });

  it('maps every instant within one bar to the same coordinate', () => {
    // The property that makes `(instrument, bar_timestamp)` a usable join key
    // between a live run and a replay.
    const first = floorToBar(new Date('2026-08-06T14:00:00.000Z'));
    const middle = floorToBar(new Date('2026-08-06T14:32:07.412Z'));
    const last = floorToBar(new Date('2026-08-06T14:59:59.999Z'));

    expect(middle).toEqual(first);
    expect(last).toEqual(first);
    // ...and the next bar is a different coordinate, not the same one.
    expect(floorToBar(new Date('2026-08-06T15:00:00.000Z'))).not.toEqual(first);
  });

  it('floors in UTC, not local time', () => {
    // A local-time floor would put the boundary at :30 on a half-hour offset
    // zone, and every stored coordinate would depend on where the process ran.
    expect(floorToBar(new Date('2026-08-06T00:15:00.000Z'))).toEqual(
      new Date('2026-08-06T00:00:00.000Z'),
    );
  });

  it('takes the timeframe as a parameter, so the choice is not baked in', () => {
    const fifteenMinutes = 15 * 60 * 1_000;
    expect(floorToBar(new Date('2026-08-06T14:32:07Z'), fifteenMinutes)).toEqual(
      new Date('2026-08-06T14:30:00.000Z'),
    );
  });

  it('defaults to the hour the rest of the system already decides on', () => {
    // `DEFAULT_INDICATOR_TIMEFRAME` and `DEFAULT_TRADER_CONFIG.atr_timeframe`
    // are both 1h; a second bar concept would be the drift this avoids.
    expect(DEBATE_BAR_TIMEFRAME_MS).toBe(60 * 60 * 1_000);
  });
});
