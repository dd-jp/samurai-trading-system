import { describe, expect, it } from 'vitest';
import { openSharedStore } from '../shared/store/open-shared-store.js';
import type { SetupNeighbor, SetupStore, SetupVector } from '../shared/types.js';
import {
  cosineSimilarity,
  K_NEIGHBORS,
  MAX_MULTIPLIER,
  MIN_MULTIPLIER,
  MIN_SIMILARITY_THRESHOLD,
  NO_PRECEDENT_MULTIPLIER,
  retrieveCosinePrecedent,
} from './cosine-precedent.js';
import { FixtureSetupStore } from './fixture-setup-store.js';
import { SqliteSetupStore } from './sqlite-setup-store.js';

const NOW = new Date('2026-07-15T12:00:00Z');
const DECIDED_AT = new Date('2026-07-15T08:00:00Z');
const CLOSED_BEFORE_NOW = new Date('2026-07-15T10:00:00Z');
const CLOSED_AFTER_NOW = new Date('2026-07-15T14:00:00Z');

const TARGET: SetupVector = {
  debate_features: [0.7, 1, 1, 0.1],
  market_features: [0.3, 0.5],
};

function neighbor(
  overrides: Partial<SetupNeighbor> & { r_multiple: number; closed_at?: Date },
): SetupNeighbor {
  return {
    vector: TARGET,
    closed_at: CLOSED_BEFORE_NOW,
    ...overrides,
  };
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns 0 when either vector is all zeros', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });

  it('throws on mismatched vector lengths', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
  });
});

/**
 * Retrieval behaviour is a property of the `SetupStore` port, so every case
 * runs against both implementations: the in-memory fixture and the real
 * SQLite-backed store over `cosine_setups` (#198). Seeding goes through the
 * port itself (`writeSetup` + `labelSetup`) rather than the fixture's
 * constructor, since that is the only way a real store can be populated.
 */
const STORE_IMPLEMENTATIONS: Array<[string, () => SetupStore]> = [
  ['FixtureSetupStore', () => new FixtureSetupStore()],
  ['SqliteSetupStore', () => new SqliteSetupStore(openSharedStore(':memory:'))],
];

describe.each(STORE_IMPLEMENTATIONS)('retrieveCosinePrecedent (%s)', (_name, makeStore) => {
  function seeded(neighbors: SetupNeighbor[]): SetupStore {
    const store = makeStore();
    neighbors.forEach((entry, index) => {
      const debateId = `debate-${index}`;
      store.writeSetup(debateId, entry.vector, DECIDED_AT);
      store.labelSetup(debateId, entry.r_multiple, entry.closed_at);
    });
    return store;
  }

  it('returns nearest setups by cosine similarity with R-multiple labels', () => {
    const store = seeded([neighbor({ r_multiple: 1.5 }), neighbor({ r_multiple: -0.5 })]);

    const result = retrieveCosinePrecedent(TARGET, store, NOW);

    expect(result.neighbor_count).toBe(2);
    expect(result.no_precedent).toBe(false);
    expect(result.weighted_mean_r).not.toBeNull();
  });

  it('sizes up within bound for a strongly precedent-supported setup', () => {
    const store = seeded([
      neighbor({ r_multiple: 2 }),
      neighbor({ r_multiple: 2.5 }),
      neighbor({ r_multiple: 3 }),
    ]);

    const result = retrieveCosinePrecedent(TARGET, store, NOW);

    expect(result.cosine_multiplier).toBeGreaterThan(1.0);
    expect(result.cosine_multiplier).toBeLessThanOrEqual(MAX_MULTIPLIER);
    expect(result.cosine_multiplier).toBeGreaterThanOrEqual(MIN_MULTIPLIER);
  });

  it('sizes down within bound for a contrary-precedent setup', () => {
    const store = seeded([
      neighbor({ r_multiple: -2 }),
      neighbor({ r_multiple: -2.5 }),
      neighbor({ r_multiple: -1.5 }),
    ]);

    const result = retrieveCosinePrecedent(TARGET, store, NOW);

    expect(result.cosine_multiplier).toBeLessThan(1.0);
    expect(result.cosine_multiplier).toBeGreaterThanOrEqual(MIN_MULTIPLIER);
    expect(result.cosine_multiplier).toBeLessThanOrEqual(MAX_MULTIPLIER);
  });

  it('never exceeds the 0.5x-1.5x bound even for extreme R-multiples', () => {
    const bullish = seeded([neighbor({ r_multiple: 50 })]);
    const bearish = seeded([neighbor({ r_multiple: -50 })]);

    expect(retrieveCosinePrecedent(TARGET, bullish, NOW).cosine_multiplier).toBe(MAX_MULTIPLIER);
    expect(retrieveCosinePrecedent(TARGET, bearish, NOW).cosine_multiplier).toBe(MIN_MULTIPLIER);
  });

  it('defaults to 0.75x with no_precedent flag when the store is empty', () => {
    const store = seeded([]);

    const result = retrieveCosinePrecedent(TARGET, store, NOW);

    expect(result.cosine_multiplier).toBe(NO_PRECEDENT_MULTIPLIER);
    expect(result.neighbor_count).toBe(0);
    expect(result.weighted_mean_r).toBeNull();
    expect(result.no_precedent).toBe(true);
  });

  it('defaults to 0.75x when no neighbor meets the similarity threshold', () => {
    const dissimilar: SetupVector = {
      debate_features: [-0.7, -1, -1, -0.1],
      market_features: [-0.3, -0.5],
    };
    const store = seeded([neighbor({ vector: dissimilar, r_multiple: 3 })]);

    const result = retrieveCosinePrecedent(TARGET, store, NOW);

    expect(
      cosineSimilarity(
        [...TARGET.debate_features, ...TARGET.market_features],
        [...dissimilar.debate_features, ...dissimilar.market_features],
      ),
    ).toBeLessThan(MIN_SIMILARITY_THRESHOLD);
    expect(result.cosine_multiplier).toBe(NO_PRECEDENT_MULTIPLIER);
    expect(result.no_precedent).toBe(true);
  });

  it('excludes neighbors not yet closed as of the clock (point-in-time)', () => {
    const store = seeded([neighbor({ r_multiple: 3, closed_at: CLOSED_AFTER_NOW })]);

    const result = retrieveCosinePrecedent(TARGET, store, NOW);

    expect(result.no_precedent).toBe(true);
    expect(result.neighbor_count).toBe(0);
  });

  it('limits retrieval to the K nearest qualifying neighbors', () => {
    const store = seeded(
      Array.from({ length: K_NEIGHBORS + 5 }, (_, i) => neighbor({ r_multiple: 1 + i * 0.1 })),
    );

    const result = retrieveCosinePrecedent(TARGET, store, NOW);

    expect(result.neighbor_count).toBe(K_NEIGHBORS);
  });
});
