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
        // #617 (migration 0026). NULL for the same reason: this caller supplies
        // none. A row like this is NOT replayable, and `buildDebateStep` treats
        // a null `confidence` as "re-run the debate" rather than trading on a
        // reconstructed blank.
        confidence: null,
        synthesis: null,
        position: null,
        disagreement_summary: null,
        open_items_json: null,
        converged: null,
      },
    ]);
  });

  /** #617 — the row has to be able to stand in for the debate, not just describe it. */
  it('round-trips the replay fields, including converged as a boolean', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);

    store.writeLog(
      makeLog({
        confidence: 0.72,
        synthesis: 'Momentum holds.',
        position: 'bullish: momentum holds',
        disagreement_summary: 'Bear conceded on volume.',
        open_items: ['liquidity thin into the close'],
        converged: true,
      }),
    );

    const read = store.getByDebateId('debate-1');

    expect(read?.confidence).toBe(0.72);
    expect(read?.synthesis).toBe('Momentum holds.');
    expect(read?.position).toBe('bullish: momentum holds');
    expect(read?.disagreement_summary).toBe('Bear conceded on volume.');
    expect(read?.open_items).toEqual(['liquidity thin into the close']);
    // SQLite stores 1/0; the domain object must get a boolean back.
    expect(read?.converged).toBe(true);
  });

  it('reads a pre-0026 row as having no replay fields at all, not as zeroes', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);

    store.writeLog(makeLog());

    const read = store.getByDebateId('debate-1');

    // Absent, not 0/''/false. `confidence: 0` would be a legitimate score and
    // would send a non-replayable row down the replay path.
    expect(read).not.toHaveProperty('confidence');
    expect(read).not.toHaveProperty('converged');
    expect(read).not.toHaveProperty('open_items');
  });

  it('preserves converged: false rather than dropping it as falsy', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);

    store.writeLog(makeLog({ confidence: 0.6, converged: false }));

    expect(store.getByDebateId('debate-1')?.converged).toBe(false);
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
