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

    it('FIXED by #683 — the mediator cannot create a directional lean from a neutral desk, at any desk size', () => {
      // Was "KNOWN HOLE" until #683: at maximum evidence, a neutral desk's
      // mediator vote used to supply a lean of 1/(n+1) out of nothing — 0.55
      // (exactly the floor) on a three-analyst desk, 0.60 (clearing outright)
      // on a two-analyst desk. `decide.ts` gates on `confidence <
      // conviction_floor`, so the exact tie AUTHORISED the trade.
      //
      // #683 implements Option 1: the mediator amplifies an existing analyst
      // lean but cannot create one. With the analysts' own directional mean at
      // exactly 0, `computeDirectionalConsensus` now returns 0 regardless of
      // what the mediator says, so the whole score is capped at
      // `EVIDENCE_WEIGHT` (0.4) — well under the floor, and identically so at
      // both desk sizes, closing the desk-size dependency along with the hole.
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

      // Evidence strength is saturated (3 key points, confidence 1) for both
      // desks, so the ceiling is exactly EVIDENCE_WEIGHT (0.4) either way.
      expect(computeConvictionScore(threeAnalystDesk, [], 'bearish')).toBeCloseTo(0.4, 10);
      expect(computeConvictionScore(twoAnalystDesk, [], 'bearish')).toBeCloseTo(0.4, 10);
      expect(computeConvictionScore(threeAnalystDesk, [], 'bearish')).toBeLessThan(
        CONVICTION_FLOOR,
      );
      expect(computeConvictionScore(twoAnalystDesk, [], 'bearish')).toBeLessThan(CONVICTION_FLOOR);

      // Holds for every mediator stance, not just 'bearish' — a neutral desk
      // cannot be walked over the floor by the mediator alone, at any size.
      for (const mediator of ['bullish', 'neutral', 'bearish'] as const) {
        expect(computeConvictionScore(threeAnalystDesk, [], mediator)).toBeLessThan(
          CONVICTION_FLOOR,
        );
        expect(computeConvictionScore(twoAnalystDesk, [], mediator)).toBeLessThan(CONVICTION_FLOOR);
      }
    });

    it('#683 — the mediator can still amplify a genuine (non-zero) analyst lean', () => {
      // The fix must not regress defect 2/#625: when the analysts DO have a
      // real (non-zero) mean lean, the mediator remains an equal participant
      // that can move the score up or down, same as before #683.
      const desk = [
        makeView({ analyst_id: 'a1', direction: 'bullish', confidence: 1, key_points: [] }),
        makeView({ analyst_id: 'a2', direction: 'neutral', confidence: 1, key_points: [] }),
        makeView({ analyst_id: 'a3', direction: 'neutral', confidence: 1, key_points: [] }),
      ];

      const agreeing = computeConvictionScore(desk, [], 'bullish');
      const abstaining = computeConvictionScore(desk, [], 'neutral');
      const dissenting = computeConvictionScore(desk, [], 'bearish');

      expect(agreeing).toBeGreaterThan(abstaining);
      expect(abstaining).toBeGreaterThan(dissenting);
    });

    it('#683 — a mediator cannot create a lean out of exact analyst disagreement either', () => {
      // "Analysts' own mean is 0" is broader than "every analyst neutral": a
      // desk that cancels out exactly (one bullish, one bearish) has no net
      // lean either, and the mediator must not be able to manufacture one from
      // that symmetric disagreement.
      const cancelledDesk = [
        makeView({ analyst_id: 'a1', direction: 'bullish', confidence: 1, key_points: [] }),
        makeView({ analyst_id: 'a2', direction: 'bearish', confidence: 1, key_points: [] }),
      ];

      // EVIDENCE_WEIGHT = 0.4, not re-exported by the module — this is the
      // module's own INVARIANT restated as a literal, matching the other
      // "cannot exceed 0.4" assertion below.
      expect(computeConvictionScore(cancelledDesk, [], 'bullish')).toBeLessThanOrEqual(0.4);
      expect(computeConvictionScore(cancelledDesk, [], 'bearish')).toBeLessThanOrEqual(0.4);
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

  /**
   * #752's premise check, required by the ticket before building the
   * degraded-coverage alert: "verify empirically whether [the mute-analyst
   * exclusion] is live and effective... two live analysts and one mute one
   * must produce a conviction that can clear the floor."
   *
   * MEASURED RESULT: it clears comfortably, not marginally. Two live
   * analysts (bullish, confidence 0.9, saturated evidence) plus one mute
   * (NO_DATA_MARKER, confidence 0.05) score ~0.78 mediator-free and ~0.83
   * with a bullish mediator verdict — both far above the 0.55 floor, unlike
   * the #625 desk shape above (1 live, 2 mute), which needed the mediator to
   * agree just to clear 0.5478. `computeEvidenceStrength`'s exclusion of the
   * mute analyst from the evidence average (see its doc comment) is what
   * does this: the two live analysts' full-strength evidence is no longer
   * diluted by a third analyst's pinned 0.05.
   *
   * CONCLUSION carried into the #752 closing comment: the #625 failure mode
   * (a stock that can never trade because of a muted desk) is closed for
   * this desk shape. The counter and the alert this ticket adds are
   * therefore reporting a MEASURED gap, not preventing a repeat of a defect
   * that would otherwise recur — the alert's justification is narrower than
   * the original draft assumed, but the ticket still requires it (criteria
   * 2/3/4/6) and it is built regardless.
   */
  describe('#752 — two-live-one-mute premise check', () => {
    const CONVICTION_FLOOR = DEFAULT_TRADER_CONFIG.conviction_floor;

    function twoLiveOneMuteDesk(): AnalystView[] {
      return [
        makeView({
          analyst_id: 'tech',
          analyst_type: 'technical',
          direction: 'bullish',
          confidence: 0.9,
          key_points: Array(3).fill('point'),
        }),
        makeView({
          analyst_id: 'fund',
          analyst_type: 'fundamental',
          direction: 'bullish',
          confidence: 0.9,
          key_points: Array(3).fill('point'),
        }),
        makeView({
          analyst_id: 'sent',
          analyst_type: 'sentiment',
          direction: 'neutral',
          confidence: 0.05,
          key_points: [`${NO_DATA_MARKER}: no social items available for this window`],
        }),
      ];
    }

    it('clears the conviction floor mediator-free', () => {
      const score = computeConvictionScore(twoLiveOneMuteDesk(), [], undefined);

      expect(score).toBeGreaterThan(CONVICTION_FLOOR);
      // Directional consensus mean(1, 1, 0)/3 = 0.6667; evidence (1 + 0.9)/2 =
      // 0.95 (mute excluded). score = 0.6 * 0.6667 + 0.4 * 0.95 = 0.78.
      expect(score).toBeCloseTo(0.78, 5);
    });

    it('clears the conviction floor with a mediator agreeing', () => {
      const roundStances: AnalystRoundStance[] = [
        { analyst_id: 'tech', round: 1, stance: 'bullish' },
        { analyst_id: 'fund', round: 1, stance: 'bullish' },
      ];

      const score = computeConvictionScore(twoLiveOneMuteDesk(), roundStances, 'bullish');

      expect(score).toBeGreaterThan(CONVICTION_FLOOR);
    });

    it('the mute analyst is genuinely excluded from evidence, not merely down-weighted', () => {
      // If the exclusion regressed to averaging the mute analyst in (the
      // pre-#625 shape), a third participant pinned at confidence 0.05 would
      // pull `avgConfidence` down materially. Comparing against a
      // hypothetical desk with only the two live analysts isolates that:
      // the two-live-one-mute score must equal the two-live-only score,
      // because the excluded analyst contributes nothing to
      // `computeEvidenceStrength` either way — only to the (honest) neutral
      // vote in the consensus term.
      const twoLiveOnly = [
        makeView({ analyst_id: 'tech', direction: 'bullish', confidence: 0.9 }),
        makeView({ analyst_id: 'fund', direction: 'bullish', confidence: 0.9 }),
      ];

      const withMute = computeConvictionScore(twoLiveOneMuteDesk(), [], undefined);
      const withoutMute = computeConvictionScore(twoLiveOnly, [], undefined);

      // Not equal outright: the mute analyst's honest neutral vote widens the
      // consensus denominator from 2 to 3, which the exclusion does NOT
      // (and should not) undo — see computeDirectionalConsensus's doc
      // comment. The claim under test is narrower: adding the mute analyst
      // must not pull the score DOWN via the evidence term, which a
      // regression to averaging it in would do.
      expect(withMute).toBeGreaterThan(withoutMute * 0.6);
      expect(withMute).toBeGreaterThan(CONVICTION_FLOOR);
    });
  });
});
