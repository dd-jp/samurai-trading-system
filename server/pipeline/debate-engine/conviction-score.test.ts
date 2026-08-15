import { NO_DATA_MARKER } from '../analysts/types.js';
import { DEFAULT_TRADER_CONFIG } from '../trader/types.js';
import type { AnalystRoundStance } from './analyst-contribution.js';
import { computeConvictionScore } from './conviction-score.js';
import type { AnalystView } from './types.js';

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'analyst-technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 1,
    key_points: ['Volume confirms breakout.', 'RSI not overbought.', 'Trend intact.'],
    timestamp: new Date('2026-07-14T09:00:00Z'),
    ...overrides,
  };
}

describe('computeConvictionScore', () => {
  it('scores 1.0 on full agreement with strong evidence', () => {
    const views = [
      makeView({ analyst_id: 'a1', direction: 'bullish' }),
      makeView({ analyst_id: 'a2', direction: 'bullish' }),
      makeView({ analyst_id: 'a3', direction: 'bullish' }),
    ];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a2', round: 1, stance: 'bullish' },
      { analyst_id: 'a3', round: 1, stance: 'bullish' },
    ];

    expect(computeConvictionScore(views, roundStances, undefined)).toBe(1);
  });

  it('scores 0.0 on full disagreement with weak evidence', () => {
    const views = [
      makeView({ analyst_id: 'a1', direction: 'bullish', confidence: 0, key_points: [] }),
      makeView({ analyst_id: 'a2', direction: 'bearish', confidence: 0, key_points: [] }),
      makeView({ analyst_id: 'a3', direction: 'neutral', confidence: 0, key_points: [] }),
    ];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a2', round: 1, stance: 'bearish' },
      { analyst_id: 'a3', round: 1, stance: 'neutral' },
    ];

    expect(computeConvictionScore(views, roundStances, undefined)).toBe(0);
  });

  it('scores 0.5 on mixed signals with moderate evidence', () => {
    const views = [
      makeView({
        analyst_id: 'a1',
        direction: 'bullish',
        confidence: 0.5,
        key_points: ['Some support.'],
      }),
      makeView({
        analyst_id: 'a2',
        direction: 'neutral',
        confidence: 0.5,
        key_points: ['Some support.', 'More support.'],
      }),
    ];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a2', round: 1, stance: 'neutral' },
    ];

    // Directional consensus: mean(1, 0) = 0.5 on a [-1,1] axis. (The pre-#625
    // spread metric produced 0.5 here too, by coincidence rather than by
    // agreement — this comment described that formula until #676.)
    // Evidence strength: avg key points 1.5/3 = 0.5, avg confidence 0.5 -> 0.5.
    // score = 0.6 * 0.5 + 0.4 * 0.5 = 0.5
    expect(computeConvictionScore(views, roundStances, undefined)).toBe(0.5);
  });

  it('returns a defined default score when there are no analyst views', () => {
    expect(computeConvictionScore([], [], undefined)).toBe(0.5);
  });

  it('returns a defined score when there are no round stances (no rounds run)', () => {
    const views = [
      makeView({ analyst_id: 'a1', direction: 'bullish' }),
      makeView({ analyst_id: 'a2', direction: 'bullish' }),
    ];

    const score = computeConvictionScore(views, [], undefined);

    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBe(1);
  });

  it('falls back to the original view direction when computing agreement with no round stances', () => {
    const views = [
      makeView({ analyst_id: 'a1', direction: 'bullish' }),
      makeView({ analyst_id: 'a2', direction: 'bearish' }),
    ];

    const score = computeConvictionScore(views, [], undefined);

    expect(score).toBeLessThan(1);
  });

  it('always normalizes the score to the 0.0-1.0 range', () => {
    const views = [
      makeView({ analyst_id: 'a1', confidence: 1, key_points: Array(10).fill('point') }),
      makeView({ analyst_id: 'a2', confidence: 1, key_points: Array(10).fill('point') }),
    ];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a2', round: 1, stance: 'bullish' },
    ];

    const score = computeConvictionScore(views, roundStances, undefined);

    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('scores partial agreement by how many participants hold the direction', () => {
    const views = [
      makeView({ analyst_id: 'a1', confidence: 1, key_points: Array(3).fill('point') }),
      makeView({ analyst_id: 'a2', confidence: 1, key_points: Array(3).fill('point') }),
      makeView({ analyst_id: 'a3', confidence: 1, key_points: Array(3).fill('point') }),
    ];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a2', round: 1, stance: 'bullish' },
      { analyst_id: 'a3', round: 1, stance: 'neutral' },
    ];

    // Directional consensus: mean(1, 1, 0) = 0.667 on a [-1,1] axis.
    // Evidence strength: 1.0 (saturated key points, full confidence).
    // score = 0.6 * 0.667 + 0.4 * 1 = 0.8
    //
    // Was 0.7 before #625, under `1 - spread/2`. The difference IS the fix:
    // spread is blind to counts, so it scored two-of-three-bullish exactly the
    // same as one-of-three-bullish. A mean does not.
    expect(computeConvictionScore(views, roundStances, undefined)).toBeCloseTo(0.8, 5);
  });

  describe('#625 — the three defects that made the system unable to trade', () => {
    /**
     * The production stock shape measured in #625: the technical analyst forms
     * a directional view, while sentiment and fundamental are pinned neutral at
     * confidence 0.05 by the #436 NO_DATA branch because the Market
     * Intelligence store returns `[]` on every refresh (#552).
     */
    function stockDesk(technicalDirection: 'bullish' | 'bearish' | 'neutral'): AnalystView[] {
      const absent = (id: string, type: string): AnalystView =>
        makeView({
          analyst_id: id,
          analyst_type: type,
          direction: 'neutral',
          confidence: 0.05,
          key_points: [
            `${NO_DATA_MARKER}: no items available for this window`,
            'weight it accordingly',
          ],
        });

      return [
        makeView({
          analyst_id: 'tech',
          analyst_type: 'technical',
          direction: technicalDirection,
          confidence: 0.95,
          key_points: Array(4).fill('point'),
        }),
        absent('sent', 'sentiment'),
        absent('fund', 'fundamental'),
      ];
    }

    // The real shipped floor, not a copy — a config change must break these
    // gating tests rather than let them keep passing against a stale number.
    const CONVICTION_FLOOR = DEFAULT_TRADER_CONFIG.conviction_floor;

    it('defect 1 — a stock with a directional signal the mediator agrees with clears the floor', () => {
      // Pre-#625 this branch had a CEILING of 0.5478 against a 0.55 floor, so
      // a stock could never trade at any RSI, in any market. Gap: 0.0022.
      const score = computeConvictionScore(stockDesk('bullish'), [], 'bullish');

      expect(score).toBeGreaterThan(CONVICTION_FLOOR);
    });

    it('defect 2 — the mediator verdict moves the score', () => {
      const views = stockDesk('bullish');

      const agreeing = computeConvictionScore(views, [], 'bullish');
      const dissenting = computeConvictionScore(views, [], 'bearish');
      const abstaining = computeConvictionScore(views, [], 'neutral');

      // Pre-#625 all three were identical: the adapter echoed analyst input
      // directions back as round stances, so the debate contributed zero.
      expect(agreeing).toBeGreaterThan(abstaining);
      expect(abstaining).toBeGreaterThan(dissenting);
    });

    it('defect 3 — a silent desk scores LOWER than a directional one, not higher', () => {
      const silent = computeConvictionScore(stockDesk('neutral'), [], 'neutral');
      const directional = computeConvictionScore(stockDesk('bullish'), [], 'bullish');

      // Pre-#625 this was inverted: all-neutral had zero spread and scored
      // ~0.81-0.85, while a real directional opinion collapsed to ~0.53.
      expect(silent).toBeLessThan(directional);
      expect(silent).toBeLessThan(CONVICTION_FLOOR);
    });

    it('a mediator override with no analyst backing cannot authorise a trade', () => {
      // The only branch with headroom above the floor pre-#625, and the one
      // that produced both observed bearish debates — in each, the mediator
      // emitted a direction no analyst agreed with.
      const score = computeConvictionScore(stockDesk('neutral'), [], 'bearish');

      expect(score).toBeLessThan(CONVICTION_FLOOR);
    });

    it('KNOWN HOLE — the guarantee above is desk-shaped, and fails at maximum evidence', () => {
      // Characterisation, not an endorsement. The test above passes on the
      // production desk's OBSERVED evidence (0.54), but the guarantee is an
      // accident of desk shape rather than a property: the mediator's lone vote
      // supplies a lean of 1/(n+1) out of nothing, so at MAXIMUM evidence a
      // three-analyst desk scores exactly the floor and a two-analyst desk
      // clears it — a trade no analyst agreed with, which is the pre-#625
      // branch this module set out to close.
      //
      // The Trader gates on `confidence < conviction_floor` (decide.ts), so the
      // exact tie AUTHORISES the trade rather than blocking it.
      //
      // Pinned here so the hole cannot be closed silently or widen unnoticed.
      // Closing it changes what the system trades and is tracked as #683.
      const maxEvidence = (id: string): AnalystView =>
        makeView({
          analyst_id: id,
          analyst_type: 'technical',
          direction: 'neutral',
          confidence: 1,
          key_points: Array(3).fill('point'),
        });

      const threeAnalystDesk = [maxEvidence('a1'), maxEvidence('a2'), maxEvidence('a3')];
      const twoAnalystDesk = [maxEvidence('a1'), maxEvidence('a2')];

      expect(computeConvictionScore(threeAnalystDesk, [], 'bearish')).toBeCloseTo(0.55, 10);
      expect(computeConvictionScore(twoAnalystDesk, [], 'bearish')).toBeCloseTo(0.6, 10);
      expect(computeConvictionScore(threeAnalystDesk, [], 'bearish')).toBeGreaterThanOrEqual(
        CONVICTION_FLOOR,
      );
    });

    it('with no directional lean the score cannot reach any shipped floor', () => {
      // Structural, not a tuned threshold: the first term is 0 without a lean,
      // so the score is capped at EVIDENCE_WEIGHT = 0.4.
      const perfectEvidenceNoDirection = [
        makeView({
          analyst_id: 'a1',
          direction: 'bullish',
          confidence: 1,
          key_points: Array(9).fill('p'),
        }),
        makeView({
          analyst_id: 'a2',
          direction: 'bearish',
          confidence: 1,
          key_points: Array(9).fill('p'),
        }),
      ];

      expect(computeConvictionScore(perfectEvidenceNoDirection, [], 'neutral')).toBeLessThanOrEqual(
        0.4,
      );
    });
  });
});
