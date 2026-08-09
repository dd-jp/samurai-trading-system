import {
  buildDebateLog,
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
    ...overrides,
  };
}

describe('buildDebateLog', () => {
  it('projects a completed DebateResult into a DebateLog row', () => {
    const result = makeResult();
    const bar_timestamp = new Date('2026-07-14T09:00:00Z');
    const created_at = new Date('2026-07-14T09:00:08Z');

    const log = buildDebateLog(result, 'BTC-USD', bar_timestamp, created_at);

    expect(log).toEqual({
      debate_id: 'debate-1',
      instrument: 'BTC-USD',
      bar_timestamp,
      contributions: result.contributions,
      direction: 'bullish',
      rounds: 2,
      created_at,
    });
  });
});

describe('InMemoryDebateLogStore', () => {
  it('a completed debate: row exists and is joinable by debate_id', () => {
    const store = new InMemoryDebateLogStore();
    const result = makeResult();
    const log = buildDebateLog(
      result,
      'BTC-USD',
      new Date('2026-07-14T09:00:00Z'),
      new Date('2026-07-14T09:00:08Z'),
    );

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
      new Date('2026-07-14T09:00:00Z'),
      new Date('2026-07-14T09:00:08Z'),
    );
    const second = buildDebateLog(
      makeResult({ debate_id: 'debate-2', direction: 'bearish' }),
      'ETH-USD',
      new Date('2026-07-14T09:05:00Z'),
      new Date('2026-07-14T09:05:07Z'),
    );

    store.writeLog(first);
    store.writeLog(second);

    expect(store.getByDebateId('debate-1')).toEqual(first);
    expect(store.getByDebateId('debate-2')).toEqual(second);
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
    // The replay case: `BacktestHarness` advances the clock TO the bar close,
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
