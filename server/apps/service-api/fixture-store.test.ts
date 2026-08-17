/**
 * Reproducibility guard for the dashboard fixtures (#624). `fixture-store.ts`
 * used to hand-pick each analyst's `influence_score` so a debate's three
 * scores summed to 1.0 (0.62 / 0.24 / 0.14) — numbers no real debate can
 * produce, since `computeInfluenceScore` is a strict function of the stance
 * array (fraction of consecutive-round transitions that changed) and can
 * only land on 0, 0.5 or 1 for a 3-round debate, or 0 or 1 for a 2-round one.
 *
 * This recomputes every fixture debate's scores from its own recorded
 * `stance_during_debate` and compares against what the store actually
 * returns. It must fail the moment a score drifts from what
 * `computeInfluenceScore` would emit for its stances — including a
 * hand-edit back to an unreachable value like 0.62.
 */
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
    // Strict function of the stance array: 0, 1 or 2 transitions over 2 gaps
    // (a 3-round debate) collapses to exactly {0, 0.5, 1} — 0.62/0.24/0.14
    // are not in that set. Pinning the reachable set here means a future
    // change to computeInfluenceScore's shape (not just its output) would
    // also have to update this test, rather than silently letting an
    // unreachable fixture value back in.
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
