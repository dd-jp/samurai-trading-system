import type { SetupVector } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { SqliteSetupStore } from './sqlite-setup-store.js';

const VECTOR: SetupVector = { debate_features: [0.7, 1, 1, 0.1], market_features: [0.3, 0.5] };
const DECIDED_AT = new Date('2026-07-01T09:00:00Z');
const CLOSED_AT = new Date('2026-07-02T10:00:00Z');

function makeStore(instrument = 'AAPL', asset_class: 'crypto' | 'stocks' = 'stocks') {
  const db = openSharedStore(':memory:');
  return { db, store: new SqliteSetupStore(db, { instrument, asset_class }) };
}

describe('SqliteSetupStore.writeSetup', () => {
  it('persists one row per debate_id, with the vector serialized as JSON', () => {
    const { db, store } = makeStore();

    store.writeSetup('debate-1', VECTOR, DECIDED_AT);

    expect(db.prepare('SELECT * FROM cosine_setups').all()).toEqual([
      {
        debate_id: 'debate-1',
        idempotency_key: 'debate-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        debate_features_json: '[0.7,1,1,0.1]',
        market_features_json: '[0.3,0.5]',
        r_multiple: null,
        closed_at: null,
        created_at: DECIDED_AT.toISOString(),
      },
    ]);
  });

  it('writes the scoping columns from construction, incl. a derived idempotency_key', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteSetupStore(db, {
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      idempotencyKeyFor: (debateId) => `key-for-${debateId}`,
    });

    store.writeSetup('debate-1', VECTOR, DECIDED_AT);

    expect(
      db.prepare('SELECT instrument, asset_class, idempotency_key FROM cosine_setups').get(),
    ).toEqual({
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      idempotency_key: 'key-for-debate-1',
    });
  });

  /**
   * First-write-wins since #432, where `decide()` became the caller. A repeat
   * write is a re-decided bar — replay, or a crash-restart on the same bar —
   * and killing the tick over a row that already holds the same values is the
   * wrong answer. `debate_id` is a hash of the debate's inputs, so the second
   * write's vector is identical to the first's by construction.
   */
  it('ignores a duplicate write for the same debate rather than throwing', () => {
    const { db, store } = makeStore();
    store.writeSetup('debate-1', VECTOR, DECIDED_AT);

    expect(() => store.writeSetup('debate-1', VECTOR, DECIDED_AT)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM cosine_setups').get()).toEqual({ n: 1 });
  });

  it('leaves the first row untouched — created_at is the record of when it was decided', () => {
    const { db, store } = makeStore();
    store.writeSetup('debate-1', VECTOR, DECIDED_AT);

    const later = new Date(DECIDED_AT.getTime() + 60 * 60 * 1000);
    store.writeSetup('debate-1', { debate_features: [9], market_features: [9] }, later);

    expect(db.prepare('SELECT created_at, debate_features_json FROM cosine_setups').get()).toEqual({
      created_at: DECIDED_AT.toISOString(),
      debate_features_json: JSON.stringify(VECTOR.debate_features),
    });
  });
});

describe('SqliteSetupStore.labelSetup', () => {
  it('sets r_multiple and closed_at together', () => {
    const { db, store } = makeStore();
    store.writeSetup('debate-1', VECTOR, DECIDED_AT);

    store.labelSetup('debate-1', 1.5, CLOSED_AT);

    expect(db.prepare('SELECT r_multiple, closed_at FROM cosine_setups').get()).toEqual({
      r_multiple: 1.5,
      closed_at: CLOSED_AT.toISOString(),
    });
  });

  it('rejects a second label on the same debate_id without overwriting', () => {
    const { db, store } = makeStore();
    store.writeSetup('debate-1', VECTOR, DECIDED_AT);
    store.labelSetup('debate-1', 1.5, CLOSED_AT);

    expect(() => store.labelSetup('debate-1', -9, new Date('2026-07-03T10:00:00Z'))).toThrow(
      /no pending setup for debate_id 'debate-1'/,
    );
    expect(db.prepare('SELECT r_multiple, closed_at FROM cosine_setups').get()).toEqual({
      r_multiple: 1.5,
      closed_at: CLOSED_AT.toISOString(),
    });
  });

  it('rejects labelling a debate_id that was never written', () => {
    const { store } = makeStore();

    expect(() => store.labelSetup('unknown', 1, CLOSED_AT)).toThrow();
  });

  it('labels a setup whose R-multiple is exactly zero (0 is a label, not "unlabelled")', () => {
    const { store } = makeStore();
    store.writeSetup('debate-1', VECTOR, DECIDED_AT);

    store.labelSetup('debate-1', 0, CLOSED_AT);

    expect(store.findNeighbors(VECTOR, CLOSED_AT)).toHaveLength(1);
    expect(() => store.labelSetup('debate-1', 1, CLOSED_AT)).toThrow();
  });
});

describe('SqliteSetupStore.findNeighbors', () => {
  it('round-trips a labelled setup as a SetupNeighbor', () => {
    const { store } = makeStore();
    store.writeSetup('debate-1', VECTOR, DECIDED_AT);
    store.labelSetup('debate-1', 1.5, CLOSED_AT);

    expect(store.findNeighbors(VECTOR, CLOSED_AT)).toEqual([
      { vector: VECTOR, r_multiple: 1.5, closed_at: CLOSED_AT },
    ]);
  });

  it('excludes an unlabelled (still-open) setup entirely', () => {
    const { store } = makeStore();
    store.writeSetup('debate-1', VECTOR, DECIDED_AT);

    expect(store.findNeighbors(VECTOR, new Date('2030-01-01T00:00:00Z'))).toEqual([]);
  });

  it('excludes a setup closed after asOf — no lookahead', () => {
    const { store } = makeStore();
    store.writeSetup('debate-1', VECTOR, DECIDED_AT);
    store.labelSetup('debate-1', 1.5, CLOSED_AT);

    const justBefore = new Date(CLOSED_AT.getTime() - 1);
    expect(store.findNeighbors(VECTOR, justBefore)).toEqual([]);
    // Inclusive at the boundary, matching the fixture's `<=`
    expect(store.findNeighbors(VECTOR, CLOSED_AT)).toHaveLength(1);
  });

  it('compares timestamps correctly across a year boundary (canonical ISO ordering)', () => {
    const { store } = makeStore();
    store.writeSetup('old', VECTOR, new Date('2025-12-31T23:00:00Z'));
    store.labelSetup('old', 1, new Date('2025-12-31T23:59:59Z'));
    store.writeSetup('new', VECTOR, new Date('2026-01-01T00:30:00Z'));
    store.labelSetup('new', 2, new Date('2026-01-01T01:00:00Z'));

    const between = store.findNeighbors(VECTOR, new Date('2026-01-01T00:00:00Z'));
    expect(between.map((n) => n.r_multiple)).toEqual([1]);
  });
});
