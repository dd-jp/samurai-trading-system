/**
 * `SqliteCurrentTickStore` lifecycle (#96 acceptance criterion: "Unit test:
 * current_tick row lifecycle (create -> update per stage -> delete on
 * completion)"; #201 replaces the in-memory double with the real store).
 * Exercises the store in isolation; tick-runner.test.ts covers the same
 * lifecycle as driven by `SequentialTickRunner`.
 */
import { openSharedStore } from '../../shared/store/index.js';
import { SqliteCurrentTickStore } from './sqlite-current-tick-store.js';
import type { CurrentTick } from './types.js';

const TRACE_ID = 'trace-aapl-1400';

function row(overrides: Partial<CurrentTick> = {}): CurrentTick {
  return {
    instrument: 'AAPL',
    asset_class: 'stocks',
    stage: 'analysts',
    trace_id: TRACE_ID,
    updated_at: new Date('2026-07-15T14:00:00Z'),
    ...overrides,
  };
}

function makeStore(): SqliteCurrentTickStore {
  return new SqliteCurrentTickStore(openSharedStore(':memory:'));
}

describe('SqliteCurrentTickStore', () => {
  it('has no row for an instrument before any upsert (create)', () => {
    const store = makeStore();

    expect(store.get('AAPL')).toBeUndefined();
  });

  it('creates a row on the first upsert', () => {
    const store = makeStore();

    store.upsert(row());

    expect(store.get('AAPL')).toEqual(row());
  });

  it('overwrites the row per stage on subsequent upserts (update)', () => {
    const store = makeStore();

    store.upsert(row({ stage: 'analysts' }));
    store.upsert(row({ stage: 'debate', updated_at: new Date('2026-07-15T14:00:05Z') }));

    expect(store.get('AAPL')).toEqual(
      row({ stage: 'debate', updated_at: new Date('2026-07-15T14:00:05Z') }),
    );
  });

  it('deletes the row on completion', () => {
    const store = makeStore();
    store.upsert(row({ stage: 'execution' }));

    store.delete('AAPL');

    expect(store.get('AAPL')).toBeUndefined();
  });

  it('deleting an instrument with no row is a no-op', () => {
    const store = makeStore();

    expect(() => store.delete('AAPL')).not.toThrow();
    expect(store.get('AAPL')).toBeUndefined();
  });

  it('tracks each instrument independently', () => {
    const store = makeStore();

    store.upsert(row({ instrument: 'AAPL', stage: 'risk' }));
    store.upsert(row({ instrument: 'BTC-USD', asset_class: 'crypto', stage: 'analysts' }));
    store.delete('AAPL');

    expect(store.get('AAPL')).toBeUndefined();
    expect(store.get('BTC-USD')).toEqual(
      row({ instrument: 'BTC-USD', asset_class: 'crypto', stage: 'analysts' }),
    );
  });

  it('an upsert after delete safely re-creates the row (stale row overwritten next tick)', () => {
    const store = makeStore();
    store.upsert(row({ stage: 'execution' }));
    store.delete('AAPL');

    store.upsert(row({ stage: 'analysts', trace_id: 'trace-next' }));

    expect(store.get('AAPL')).toEqual(row({ stage: 'analysts', trace_id: 'trace-next' }));
  });
});
