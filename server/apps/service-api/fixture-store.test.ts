import { computeInfluenceScore } from '../../pipeline/debate-engine/analyst-contribution.js';
import { FIXTURE_NOW, InMemoryQueryStore } from './fixture-store.js';

describe('InMemoryQueryStore fixture influence scores', () => {
  it('is reproducible from stance_during_debate under computeInfluenceScore', () => {
    const store = new InMemoryQueryStore();
    const debates = store.getRecentDebates(100, FIXTURE_NOW);

    expect(debates.length).toBeGreaterThan(0);

    for (const debate of debates) {
      for (const entry of debate.contributions) {
        const expected = computeInfluenceScore([...entry.stance_during_debate]);
        expect(entry.influence_score).toBe(expected);
      }
    }
  });

  it('only produces scores computeInfluenceScore can actually emit for a 3-round debate', () => {
    const reachableFor3Rounds = new Set([0, 0.5, 1]);

    const store = new InMemoryQueryStore();
    const debates = store.getRecentDebates(100, FIXTURE_NOW);

    for (const debate of debates) {
      if (debate.rounds !== 3) {
        continue;
      }
      for (const entry of debate.contributions) {
        if (entry.stance_during_debate.length === 0) {
          continue;
        }
        expect(reachableFor3Rounds.has(entry.influence_score)).toBe(true);
      }
    }
  });
});
