import { describe, expect, it } from 'vitest';
import { openSharedStore } from '../../shared/store/open-shared-store.js';
import { SqliteCiiSnapshotStore } from './sqlite-cii-snapshot-store.js';

function makeStore() {
  return new SqliteCiiSnapshotStore(openSharedStore(':memory:'));
}

describe('SqliteCiiSnapshotStore.record', () => {
  it('persists a snapshot, readable back by readHistory', () => {
    const store = makeStore();

    store.record({ country_code: 'RU', score: 72, captured_at: new Date('2026-07-27T00:00:00Z') });

    expect(store.readHistory('RU', new Date('2026-01-01'), new Date('2030-01-01'))).toEqual([
      { country_code: 'RU', score: 72, captured_at: new Date('2026-07-27T00:00:00Z') },
    ]);
  });

  it('re-recording the same (country, captured_at) is idempotent — no duplicate row', () => {
    const store = makeStore();
    const row = { country_code: 'RU', score: 72, captured_at: new Date('2026-07-27T00:00:00Z') };

    store.record(row);
    store.record(row);

    expect(store.readHistory('RU', new Date('2026-01-01'), new Date('2030-01-01'))).toHaveLength(1);
  });

  it('rejects a score outside [0, 100] via the schema CHECK constraint', () => {
    const store = makeStore();

    expect(() =>
      store.record({
        country_code: 'RU',
        score: 101,
        captured_at: new Date('2026-07-27T00:00:00Z'),
      }),
    ).toThrow();
  });
});

describe('SqliteCiiSnapshotStore.readHistory', () => {
  it('scopes to the requested country and [from, to] window, ascending by captured_at', () => {
    const store = makeStore();
    store.record({ country_code: 'RU', score: 50, captured_at: new Date('2026-07-25T00:00:00Z') });
    store.record({ country_code: 'RU', score: 60, captured_at: new Date('2026-07-26T00:00:00Z') });
    store.record({ country_code: 'RU', score: 70, captured_at: new Date('2026-07-27T00:00:00Z') });
    store.record({ country_code: 'SA', score: 80, captured_at: new Date('2026-07-26T00:00:00Z') });

    const history = store.readHistory(
      'RU',
      new Date('2026-07-26T00:00:00Z'),
      new Date('2026-07-27T00:00:00Z'),
    );

    expect(history.map((row) => row.score)).toEqual([60, 70]);
  });

  it('returns an empty array for a country with no recorded history', () => {
    expect(makeStore().readHistory('ZZ', new Date('2026-01-01'), new Date('2030-01-01'))).toEqual(
      [],
    );
  });
});
