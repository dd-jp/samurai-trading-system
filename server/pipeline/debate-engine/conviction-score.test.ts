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

    expect(computeConvictionScore(views, roundStances, undefined)).toBeCloseTo(0.8, 5);
  });

  describe('#625 — the three defects that made the system unable to trade', () => {
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

    const CONVICTION_FLOOR = DEFAULT_TRADER_CONFIG.conviction_floor;

    it('defect 1 — a stock with a directional signal the mediator agrees with clears the floor', () => {
      const score = computeConvictionScore(stockDesk('bullish'), [], 'bullish');

      expect(score).toBeGreaterThan(CONVICTION_FLOOR);
    });

    it('defect 2 — the mediator verdict moves the score', () => {
      const views = stockDesk('bullish');

      const agreeing = computeConvictionScore(views, [], 'bullish');
      const dissenting = computeConvictionScore(views, [], 'bearish');
      const abstaining = computeConvictionScore(views, [], 'neutral');

      expect(agreeing).toBeGreaterThan(abstaining);
      expect(abstaining).toBeGreaterThan(dissenting);
    });

    it('defect 3 — a silent desk scores LOWER than a directional one, not higher', () => {
      const silent = computeConvictionScore(stockDesk('neutral'), [], 'neutral');
      const directional = computeConvictionScore(stockDesk('bullish'), [], 'bullish');

      expect(silent).toBeLessThan(directional);
      expect(silent).toBeLessThan(CONVICTION_FLOOR);
    });

    it('a mediator override with no analyst backing cannot authorise a trade', () => {
      const score = computeConvictionScore(stockDesk('neutral'), [], 'bearish');

      expect(score).toBeLessThan(CONVICTION_FLOOR);
    });

    it('FIXED by #683 — the mediator cannot create a directional lean from a neutral desk, at any desk size', () => {
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

      expect(computeConvictionScore(threeAnalystDesk, [], 'bearish')).toBeCloseTo(0.4, 10);
      expect(computeConvictionScore(twoAnalystDesk, [], 'bearish')).toBeCloseTo(0.4, 10);
      expect(computeConvictionScore(threeAnalystDesk, [], 'bearish')).toBeLessThan(
        CONVICTION_FLOOR,
      );
      expect(computeConvictionScore(twoAnalystDesk, [], 'bearish')).toBeLessThan(CONVICTION_FLOOR);

      for (const mediator of ['bullish', 'neutral', 'bearish'] as const) {
        expect(computeConvictionScore(threeAnalystDesk, [], mediator)).toBeLessThan(
          CONVICTION_FLOOR,
        );
        expect(computeConvictionScore(twoAnalystDesk, [], mediator)).toBeLessThan(CONVICTION_FLOOR);
      }
    });

    it('#683 — the mediator can still amplify a genuine (non-zero) analyst lean', () => {
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
      const cancelledDesk = [
        makeView({ analyst_id: 'a1', direction: 'bullish', confidence: 1, key_points: [] }),
        makeView({ analyst_id: 'a2', direction: 'bearish', confidence: 1, key_points: [] }),
      ];

      expect(computeConvictionScore(cancelledDesk, [], 'bullish')).toBeLessThanOrEqual(0.4);
      expect(computeConvictionScore(cancelledDesk, [], 'bearish')).toBeLessThanOrEqual(0.4);
    });

    it('with no directional lean the score cannot reach any shipped floor', () => {
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
      const twoLiveOnly = [
        makeView({ analyst_id: 'tech', direction: 'bullish', confidence: 0.9 }),
        makeView({ analyst_id: 'fund', direction: 'bullish', confidence: 0.9 }),
      ];

      const withMute = computeConvictionScore(twoLiveOneMuteDesk(), [], undefined);
      const withoutMute = computeConvictionScore(twoLiveOnly, [], undefined);

      expect(withMute).toBeGreaterThan(withoutMute * 0.6);
      expect(withMute).toBeGreaterThan(CONVICTION_FLOOR);
    });
  });
});
