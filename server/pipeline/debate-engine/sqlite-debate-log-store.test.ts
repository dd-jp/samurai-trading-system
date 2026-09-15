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
        // #1081 (migration 0041). NULL for the same reason: this caller
        // supplies none, and NULL is the honest "indeterminate" rather than a
        // guessed classification.
        termination: null,
        // #1380 (migration 0051). Same reason again.
        termination_cause: null,
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
    // #1081: absent, not a guessed classification — this row predates
    // migration 0041 by construction (the writer supplied no `termination`).
    expect(read).not.toHaveProperty('termination');
    // #1380: same reasoning, one migration later.
    expect(read).not.toHaveProperty('termination_cause');
  });

  it('preserves converged: false rather than dropping it as falsy', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);

    store.writeLog(makeLog({ confidence: 0.6, converged: false }));

    expect(store.getByDebateId('debate-1')?.converged).toBe(false);
  });

  /**
   * #1081 — the column that lets a truncated debate be told apart from a
   * genuinely non-converged one from the stored record alone, without
   * reading logs.
   */
  it('round-trips termination', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);

    store.writeLog(makeLog({ debate_id: 'debate-truncated', termination: 'latency_truncated' }));

    expect(
      db.prepare('SELECT termination FROM debate_log WHERE debate_id = ?').get('debate-truncated'),
    ).toEqual({
      termination: 'latency_truncated',
    });
    expect(store.getByDebateId('debate-truncated')?.termination).toBe('latency_truncated');
  });

  /**
   * #1380 (migration 0051) — the column that lets a query exclude an outright
   * LLM failure from a `latency_truncated` count meant to measure genuine
   * budget pressure, without parsing a log line.
   */
  it('round-trips termination_cause', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);

    store.writeLog(
      makeLog({
        debate_id: 'debate-llm-failed',
        termination: 'latency_truncated',
        termination_cause: 'llm_failure',
      }),
    );

    expect(
      db
        .prepare('SELECT termination_cause FROM debate_log WHERE debate_id = ?')
        .get('debate-llm-failed'),
    ).toEqual({
      termination_cause: 'llm_failure',
    });
    expect(store.getByDebateId('debate-llm-failed')?.termination_cause).toBe('llm_failure');
  });

  it('round-trips termination_cause of budget', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);

    store.writeLog(
      makeLog({
        debate_id: 'debate-budget-exceeded',
        termination: 'latency_truncated',
        termination_cause: 'budget',
      }),
    );

    expect(
      db
        .prepare('SELECT termination_cause FROM debate_log WHERE debate_id = ?')
        .get('debate-budget-exceeded'),
    ).toEqual({
      termination_cause: 'budget',
    });
    expect(store.getByDebateId('debate-budget-exceeded')?.termination_cause).toBe('budget');
  });

  it('distinguishes latency_truncated from non_converged in the persisted row', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);

    store.writeLog(
      makeLog({
        debate_id: 'debate-truncated',
        converged: false,
        termination: 'latency_truncated',
      }),
    );
    store.writeLog(
      makeLog({ debate_id: 'debate-disagreed', converged: false, termination: 'non_converged' }),
    );

    const truncated = store.getByDebateId('debate-truncated');
    const disagreed = store.getByDebateId('debate-disagreed');

    // Same converged: false — the pre-#1081 ambiguity.
    expect(truncated?.converged).toBe(disagreed?.converged);
    // Different termination — the fix.
    expect(truncated?.termination).toBe('latency_truncated');
    expect(disagreed?.termination).toBe('non_converged');
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

  it.each([
    ['not json at all', 'not json at all'],
    ['an object', '{"a":1}'],
    ['a bare string', '"open item"'],
    ['an array of non-strings', '[1,2,3]'],
  ])('reads a row whose open_items_json is %s as having no open items', (_label, raw) => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.writeLog(makeLog({ debate_id: 'debate-bad-json' }));
    db.prepare('UPDATE debate_log SET open_items_json = ? WHERE debate_id = ?').run(
      raw,
      'debate-bad-json',
    );

    // Degrading rather than throwing is the point. Since #617 this read runs
    // BEFORE the debate on every tick, so an unparseable row would fail the
    // debate stage for every remaining tick of that bar instead of falling
    // through to a re-run. The `as string[]` was unchecked too: a column
    // holding an object or a bare string would have reached a caller expecting
    // an array.
    const row = store.getByDebateId('debate-bad-json');

    expect(row).toBeDefined();
    expect(row?.open_items).toBeUndefined();
  });
});

describe('SqliteDebateLogStore.getTerminationCauseWindowCounts (#1396)', () => {
  it('counts an explicit llm_failure row and excludes it from non_failure', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.writeLog(
      makeLog({
        debate_id: 'd1',
        created_at: new Date('2026-07-14T09:00:00Z'),
        termination: 'latency_truncated',
        termination_cause: 'llm_failure',
      }),
    );

    const counts = store.getTerminationCauseWindowCounts(
      new Date('2026-07-14T08:00:00Z'),
      new Date('2026-07-14T10:00:00Z'),
    );
    expect(counts).toEqual({ llm_failure: 1, total: 1, gate_refused: 0 });
  });

  it('counts a budget truncation as non-failure', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.writeLog(
      makeLog({
        debate_id: 'd1',
        created_at: new Date('2026-07-14T09:00:00Z'),
        termination: 'latency_truncated',
        termination_cause: 'budget',
      }),
    );

    const counts = store.getTerminationCauseWindowCounts(
      new Date('2026-07-14T08:00:00Z'),
      new Date('2026-07-14T10:00:00Z'),
    );
    expect(counts).toEqual({ llm_failure: 0, total: 1, gate_refused: 0 });
  });

  it('counts a truncated row with a pre-migration-0051 NULL termination_cause as non-failure (AC3)', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    // `termination` set (post-0041) but no `termination_cause` supplied —
    // the exact shape a truncated row written between migrations 0041 and
    // 0051 has: a genuine truncation whose cause is indeterminate.
    store.writeLog(
      makeLog({
        debate_id: 'd1',
        created_at: new Date('2026-07-14T09:00:00Z'),
        termination: 'latency_truncated',
      }),
    );

    const counts = store.getTerminationCauseWindowCounts(
      new Date('2026-07-14T08:00:00Z'),
      new Date('2026-07-14T10:00:00Z'),
    );
    expect(counts).toEqual({ llm_failure: 0, total: 1, gate_refused: 0 });
  });

  // review round 1 F2: the denominator is truncations (`termination =
  // 'latency_truncated'`), matching the guard's own "one in four
  // truncations" threshold rationale — not every debate_log row. A converged
  // debate never had a cause to classify and must not dilute the rate.
  it('excludes a converged (non-truncated) row from total', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.writeLog(
      makeLog({
        debate_id: 'd1',
        created_at: new Date('2026-07-14T09:00:00Z'),
        termination: 'converged',
        converged: true,
      }),
    );

    const counts = store.getTerminationCauseWindowCounts(
      new Date('2026-07-14T08:00:00Z'),
      new Date('2026-07-14T10:00:00Z'),
    );
    expect(counts).toEqual({ llm_failure: 0, total: 0, gate_refused: 0 });
  });

  it('excludes a non-converged (real disagreement, non-truncated) row from total', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.writeLog(
      makeLog({
        debate_id: 'd1',
        created_at: new Date('2026-07-14T09:00:00Z'),
        termination: 'non_converged',
        converged: false,
      }),
    );

    const counts = store.getTerminationCauseWindowCounts(
      new Date('2026-07-14T08:00:00Z'),
      new Date('2026-07-14T10:00:00Z'),
    );
    expect(counts).toEqual({ llm_failure: 0, total: 0, gate_refused: 0 });
  });

  it('excludes a pre-migration-0041 row (termination itself NULL) from total', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    // No `termination`/`termination_cause` supplied — writes NULL on both
    // columns, the shape a row written before migration 0041 has. Whether
    // it was ever truncated is genuinely unknown, so it must not count as a
    // known non-failure truncation either (migration 0041's "NULL means
    // INDETERMINATE" invariant).
    store.writeLog(makeLog({ debate_id: 'd1', created_at: new Date('2026-07-14T09:00:00Z') }));

    const counts = store.getTerminationCauseWindowCounts(
      new Date('2026-07-14T08:00:00Z'),
      new Date('2026-07-14T10:00:00Z'),
    );
    expect(counts).toEqual({ llm_failure: 0, total: 0, gate_refused: 0 });
  });

  it('excludes rows outside the (from, to] window', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.writeLog(
      makeLog({
        debate_id: 'too-early',
        created_at: new Date('2026-07-14T07:59:59Z'),
        termination: 'latency_truncated',
        termination_cause: 'llm_failure',
      }),
    );
    store.writeLog(
      makeLog({
        debate_id: 'in-window',
        created_at: new Date('2026-07-14T09:00:00Z'),
        termination: 'latency_truncated',
        termination_cause: 'llm_failure',
      }),
    );

    const counts = store.getTerminationCauseWindowCounts(
      new Date('2026-07-14T08:00:00Z'),
      new Date('2026-07-14T10:00:00Z'),
    );
    expect(counts).toEqual({ llm_failure: 1, total: 1, gate_refused: 0 });
  });

  it('returns zero counts for an empty window rather than NULL/NaN', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);

    const counts = store.getTerminationCauseWindowCounts(
      new Date('2026-07-14T08:00:00Z'),
      new Date('2026-07-14T10:00:00Z'),
    );
    expect(counts).toEqual({ llm_failure: 0, total: 0, gate_refused: 0 });
  });
});

describe('SqliteDebateLogStore.recordGateRefusal / gate_refused (#1533)', () => {
  it('counts a recorded refusal even though no debate_log row exists at all', () => {
    // The scenario the migration's header names: a gate-refused debate never
    // resolves to a `debate_id`, so there is no `debate_log` row for it to
    // ride on. This must still be visible to the window read.
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.recordGateRefusal(new Date('2026-07-14T09:00:00Z'));

    const counts = store.getTerminationCauseWindowCounts(
      new Date('2026-07-14T08:00:00Z'),
      new Date('2026-07-14T10:00:00Z'),
    );
    expect(counts).toEqual({ llm_failure: 0, total: 0, gate_refused: 1 });
  });

  it('blends with genuine debate_log truncations rather than replacing them', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.writeLog(
      makeLog({
        debate_id: 'd1',
        created_at: new Date('2026-07-14T09:00:00Z'),
        termination: 'latency_truncated',
        termination_cause: 'llm_failure',
      }),
    );
    store.recordGateRefusal(new Date('2026-07-14T09:05:00Z'));
    store.recordGateRefusal(new Date('2026-07-14T09:06:00Z'));

    const counts = store.getTerminationCauseWindowCounts(
      new Date('2026-07-14T08:00:00Z'),
      new Date('2026-07-14T10:00:00Z'),
    );
    expect(counts).toEqual({ llm_failure: 1, total: 1, gate_refused: 2 });
  });

  it("excludes a refusal outside the (from, to] window, matching debate_log's own boundary", () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.recordGateRefusal(new Date('2026-07-14T07:59:59Z')); // before `from`
    store.recordGateRefusal(new Date('2026-07-14T08:00:00Z')); // exactly `from` — excluded, `>` not `>=`
    store.recordGateRefusal(new Date('2026-07-14T09:00:00Z')); // in window
    store.recordGateRefusal(new Date('2026-07-14T10:00:00Z')); // exactly `to` — included, `<=`

    const counts = store.getTerminationCauseWindowCounts(
      new Date('2026-07-14T08:00:00Z'),
      new Date('2026-07-14T10:00:00Z'),
    );
    expect(counts.gate_refused).toBe(2);
  });

  it('does not write any debate_log row as a side effect', () => {
    // The invariant the whole migration exists to protect: a refusal must
    // never occupy a debate_id.
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.recordGateRefusal(new Date('2026-07-14T09:00:00Z'));

    expect(store.getByDebateId('debate-1')).toBeUndefined();
  });
});

describe('SqliteDebateLogStore.writeRoundLog / listRoundVerdicts (#1517)', () => {
  it('persists rows and reads them back in round order, joined by debate_id', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.writeLog(makeLog({ debate_id: 'debate-1' }));

    store.writeRoundLog([
      {
        debate_id: 'debate-1',
        round: 1,
        direction: 'bearish',
        confidence: 0.3,
        created_at: new Date('2026-07-14T09:00:08Z'),
      },
      {
        debate_id: 'debate-1',
        round: 2,
        direction: 'bullish',
        confidence: 0.7,
        created_at: new Date('2026-07-14T09:00:08Z'),
      },
    ]);

    const rows = store.listRoundVerdicts(
      new Date('2026-07-14T08:00:00Z'),
      new Date('2026-07-14T10:00:00Z'),
    );
    expect(rows).toEqual([
      {
        debate_id: 'debate-1',
        round: 1,
        direction: 'bearish',
        confidence: 0.3,
        created_at: new Date('2026-07-14T09:00:08Z'),
      },
      {
        debate_id: 'debate-1',
        round: 2,
        direction: 'bullish',
        confidence: 0.7,
        created_at: new Date('2026-07-14T09:00:08Z'),
      },
    ]);
  });

  it('is a no-op on an empty array', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.writeLog(makeLog({ debate_id: 'debate-1' }));

    expect(() => store.writeRoundLog([])).not.toThrow();
    expect(
      store.listRoundVerdicts(new Date('2026-07-14T08:00:00Z'), new Date('2026-07-14T10:00:00Z')),
    ).toEqual([]);
  });

  it('excludes rows outside the (from, to] window', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    store.writeLog(makeLog({ debate_id: 'debate-1' }));
    store.writeRoundLog([
      {
        debate_id: 'debate-1',
        round: 1,
        direction: 'bullish',
        confidence: 0.5,
        created_at: new Date('2026-07-14T07:59:59Z'),
      },
    ]);

    expect(
      store.listRoundVerdicts(new Date('2026-07-14T08:00:00Z'), new Date('2026-07-14T10:00:00Z')),
    ).toEqual([]);
  });
});

describe('SqliteDebateLogStore.writeLogWithRounds (#1558 review)', () => {
  it('writes the debate_log row and all round rows together', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);

    store.writeLogWithRounds(makeLog({ debate_id: 'debate-1' }), [
      {
        debate_id: 'debate-1',
        round: 1,
        direction: 'bearish',
        confidence: 0.3,
        created_at: new Date('2026-07-14T09:00:08Z'),
      },
      {
        debate_id: 'debate-1',
        round: 2,
        direction: 'bullish',
        confidence: 0.7,
        created_at: new Date('2026-07-14T09:00:08Z'),
      },
    ]);

    expect(store.getByDebateId('debate-1')).toBeDefined();
    expect(
      store.listRoundVerdicts(new Date('2026-07-14T08:00:00Z'), new Date('2026-07-14T10:00:00Z')),
    ).toHaveLength(2);
  });

  it('rolls back the debate_log row when the round write fails partway through', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);

    // Two entries sharing round 1 violate debate_round_log's UNIQUE(debate_id,
    // round) (migration 0064) on the second insert — standing in for the
    // "mid-loop failure" writeLogWithRounds' own doc comment names, without a
    // second call to writeLog to break the log write itself.
    expect(() =>
      store.writeLogWithRounds(makeLog({ debate_id: 'debate-1' }), [
        {
          debate_id: 'debate-1',
          round: 1,
          direction: 'bearish',
          confidence: 0.3,
          created_at: new Date('2026-07-14T09:00:08Z'),
        },
        {
          debate_id: 'debate-1',
          round: 1,
          direction: 'bullish',
          confidence: 0.7,
          created_at: new Date('2026-07-14T09:00:09Z'),
        },
      ]),
    ).toThrow();

    // The debate_log row from the SAME writeLogWithRounds call must not
    // survive the round write's failure — otherwise persistDebateLog's
    // first-write-wins guard (getByDebateId) would permanently block the
    // round rows from ever being written on retry.
    expect(store.getByDebateId('debate-1')).toBeUndefined();
    expect(
      store.listRoundVerdicts(new Date('2026-07-14T08:00:00Z'), new Date('2026-07-14T10:00:00Z')),
    ).toEqual([]);
  });
});
