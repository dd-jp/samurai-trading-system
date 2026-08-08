import type { SetupVector } from '../../shared/index.js';
import { FixtureSetupStore } from './fixture-setup-store.js';

const VECTOR: SetupVector = { debate_features: [0.7, 1, 1, 0.1], market_features: [0.3, 0.5] };

describe('FixtureSetupStore.labelSetup', () => {
  it('makes a written setup discoverable via findNeighbors once labelled', () => {
    const store = new FixtureSetupStore();
    const decidedAt = new Date('2026-07-01T09:00:00Z');
    const closedAt = new Date('2026-07-02T10:00:00Z');
    store.writeSetup('debate-1', VECTOR, decidedAt);

    expect(store.findNeighbors(VECTOR, closedAt)).toHaveLength(0);

    store.labelSetup('debate-1', 1.5, closedAt);

    const neighbors = store.findNeighbors(VECTOR, closedAt);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]).toEqual({ vector: VECTOR, r_multiple: 1.5, closed_at: closedAt });
  });

  it('throws when labelling a debate_id that was never written', () => {
    const store = new FixtureSetupStore();
    expect(() => store.labelSetup('unknown', 1, new Date())).toThrow();
  });

  it('throws when labelling the same debate_id twice', () => {
    const store = new FixtureSetupStore();
    store.writeSetup('debate-1', VECTOR, new Date('2026-07-01T09:00:00Z'));
    store.labelSetup('debate-1', 1, new Date('2026-07-02T10:00:00Z'));

    expect(() => store.labelSetup('debate-1', 1, new Date('2026-07-02T10:00:00Z'))).toThrow();
  });
});
