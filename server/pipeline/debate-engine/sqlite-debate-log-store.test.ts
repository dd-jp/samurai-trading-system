import type { DebateLog } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { SqliteDebateLogStore } from './sqlite-debate-log-store.js';
import type { AnalystContribution } from './types.js';

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

function makeLog(overrides: Partial<DebateLog> = {}): DebateLog {
  return {
    debate_id: 'debate-1',
    instrument: 'BTC-USD',
    bar_timestamp: new Date('2026-07-14T09:00:00Z'),
    contributions: [makeContribution()],
    direction: 'bullish',
    rounds: 2,
    created_at: new Date('2026-07-14T09:00:08Z'),
    ...overrides,
  };
}

describe('SqliteDebateLogStore.writeLog', () => {
  it('persists one row per debate_id, with contributions serialized as JSON', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const log = makeLog();

    store.writeLog(log);

    expect(db.prepare('SELECT * FROM debate_log').all()).toEqual([
      {
        debate_id: 'debate-1',
        instrument: 'BTC-USD',
        bar_timestamp: log.bar_timestamp.toISOString(),
        contributions_json: JSON.stringify(log.contributions),
        direction: 'bullish',
        rounds: 2,
        created_at: log.created_at.toISOString(),
        // #426. NULL when the caller supplied no trace — a pre-#426 row and a
        // programmatic writer both land here.
        trace_id: null,
      },
    ]);
  });

  /** #426 — the column the Pipeline drawer joins on. */
  it('persists the trace that ran the debate', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);

    store.writeLog(makeLog({ trace_id: 'trace-77' }));

    expect(db.prepare('SELECT trace_id FROM debate_log').get()).toEqual({ trace_id: 'trace-77' });
    expect(store.getByDebateId('debate-1')?.trace_id).toBe('trace-77');
  });

  it('reads back a pre-#426 row as having no trace, rather than a null one', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.writeLog(makeLog());

    expect(store.getByDebateId('debate-1')).not.toHaveProperty('trace_id');
  });

  it('rejects a duplicate write for the same debate_id (debate_log PK)', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.writeLog(makeLog());

    expect(() => store.writeLog(makeLog({ direction: 'bearish' }))).toThrow(
      /already exists for debate_id 'debate-1'/,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM debate_log').get()).toEqual({ n: 1 });
  });
});

describe('SqliteDebateLogStore.getByDebateId', () => {
  it('a completed debate: row exists and is joinable by debate_id', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const log = makeLog();

    store.writeLog(log);

    expect(store.getByDebateId('debate-1')).toEqual(log);
  });

  it('a crashed/incomplete debate: no row is written, so lookup is absent', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);

    expect(store.getByDebateId('debate-never-completed')).toBeUndefined();
  });

  it('does not conflate rows across distinct debate_ids', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const first = makeLog({ debate_id: 'debate-1' });
    const second = makeLog({
      debate_id: 'debate-2',
      instrument: 'ETH-USD',
      direction: 'bearish',
      bar_timestamp: new Date('2026-07-14T09:05:00Z'),
      created_at: new Date('2026-07-14T09:05:07Z'),
    });

    store.writeLog(first);
    store.writeLog(second);

    expect(store.getByDebateId('debate-1')).toEqual(first);
    expect(store.getByDebateId('debate-2')).toEqual(second);
  });
});
