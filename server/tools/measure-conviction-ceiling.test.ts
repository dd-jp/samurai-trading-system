/**
 * Pins the #756 item-2 measurement so a change to the analyst, the conviction
 * formula or the floor cannot silently move the stocks ceiling back under the
 * floor the way #625 found it.
 *
 * These are ASSERTIONS ABOUT A MEASUREMENT, not tuning targets. If one fails,
 * the fix is to re-run `measure-conviction-ceiling.ts`, understand what moved
 * and re-state the ceiling against the floor — not to adjust the expectation
 * until it passes, and never to move `conviction_floor` to make it pass.
 */

import { describe, expect, it } from 'vitest';
import { LOW_CONVICTION_CAP } from '../pipeline/analysts/technical-analyst.js';
import { DEFAULT_TRADER_CONFIG } from '../pipeline/trader/types.js';
import {
  type ConvictionSample,
  type DeskShape,
  enumerateTechnicalLattice,
  type MediatorStance,
  measureConvictionSamples,
} from './measure-conviction-ceiling.js';

const FLOOR = DEFAULT_TRADER_CONFIG.conviction_floor;

const samples = measureConvictionSamples(FLOOR);

function directional(shape: DeskShape, mediator: MediatorStance): ConvictionSample[] {
  return samples.filter(
    (sample) =>
      sample.shape === shape && sample.mediator === mediator && sample.direction !== 'neutral',
  );
}

function ceiling(shape: DeskShape, mediator: MediatorStance): number {
  return directional(shape, mediator).reduce((max, sample) => Math.max(max, sample.conviction), 0);
}

describe('technical confidence lattice', () => {
  it('is the discrete |net| / availableAxes set over at most four voting axes', () => {
    const confidences = [
      ...new Set(enumerateTechnicalLattice().map((point) => point.confidence)),
    ].sort((a, b) => a - b);

    // `assessAxes` rounds to 4dp (`round4`), so the thirds land as 0.3333/0.6667.
    expect(confidences).toEqual([0, 0.25, 0.3333, 0.4, 0.5, 0.6667, 0.75, 1]);
  });

  it('always emits enough key points to saturate the evidence term', () => {
    // KEY_POINTS_SATURATION is 3; the smallest technical view carries 2 axis
    // lines plus the 5 fixed lines. So `keyPointsScore` is 1.0 for every
    // reachable stocks debate and the evidence term is (1 + avgConfidence) / 2.
    for (const point of enumerateTechnicalLattice()) {
      expect(point.keyPoints).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('stocks conviction ceiling vs conviction_floor (#756 item 2)', () => {
  it('the production desk shape (sentiment/fundamental absent) clears the floor', () => {
    // #625 measured 0.5478 against 0.55 and called it a total halt. The
    // post-#625 formula excludes NO_DATA analysts from the evidence average
    // and the post-#745 analyst can reach confidence 1.0, so the same desk
    // shape now tops out at 0.70.
    expect(ceiling('absent', 'agrees')).toBeCloseTo(0.7, 10);
    expect(ceiling('absent', 'agrees')).toBeGreaterThan(FLOOR);
  });

  it('clears strictly — not only on the boundary tie', () => {
    const strict = directional('absent', 'agrees').filter(
      (sample) => sample.conviction > FLOOR && sample.confidence < 1,
    );

    expect(strict.length).toBeGreaterThan(0);
  });

  it('lands EXACTLY on the floor at the weakest directional read (#683 decides it)', () => {
    const weakest = directional('absent', 'agrees')
      .filter((sample) => sample.clears)
      .reduce((min, sample) => (sample.confidence < min.confidence ? sample : min));

    expect(weakest.confidence).toBeCloseTo(0.25, 10);
    expect(weakest.conviction).toBeCloseTo(FLOOR, 10);
  });

  it('cannot trade against the mediator', () => {
    // `computeDirectionalConsensus` nets an opposing mediator against the lone
    // technical vote, so the consensus term collapses and the score cannot
    // exceed EVIDENCE_WEIGHT.
    expect(ceiling('absent', 'opposes')).toBeLessThan(FLOOR);
  });

  it('is diluted, not halted, when sentiment/fundamental return neutral data', () => {
    const hydratedNeutral = ceiling('hydrated-neutral', 'agrees');

    expect(hydratedNeutral).toBeGreaterThan(FLOOR);
    expect(hydratedNeutral).toBeLessThan(ceiling('absent', 'agrees'));
  });

  it('clears on every MI branch once the mediator agrees, at a branch-dependent threshold', () => {
    // The headline "clears from 0.25" is the ALL-ABSENT shape and is the most
    // permissive one. Fundamental and sentiment read different stores, so the
    // desk can sit on a split branch, and each branch that re-enters the
    // evidence average raises the technical confidence needed.
    const minClearing = (shape: DeskShape): number =>
      directional(shape, 'agrees')
        .filter((sample) => sample.clears)
        .reduce((min, sample) => Math.min(min, sample.confidence), 1);

    expect(minClearing('absent')).toBeCloseTo(0.25, 10);
    expect(minClearing('hydrated-split')).toBeCloseTo(0.5, 10);
    expect(minClearing('hydrated-neutral')).toBeCloseTo(0.6667, 10);

    for (const shape of [
      'absent',
      'hydrated-split',
      'hydrated-neutral',
      'hydrated-aligned',
    ] as const) {
      expect(ceiling(shape, 'agrees')).toBeGreaterThan(FLOOR);
    }
  });
});

describe('LOW_CONVICTION_CAP interaction (#756 item 3)', () => {
  it('does NOT keep a gated tape below the floor on the production desk shape', () => {
    // #745 states the 0.40 cap "sits below the 0.55 stocks conviction floor on
    // purpose". That holds for the analyst's own confidence and does NOT hold
    // for the conviction the Trader gates on: a capped 0.40 still produces
    // 0.6(0.5) + 0.4((1 + 0.4) / 2) = 0.58 once the mediator agrees.
    const cappedCeiling = directional('absent', 'agrees')
      .filter((sample) => sample.capped)
      .reduce((max, sample) => Math.max(max, sample.conviction), 0);

    expect(LOW_CONVICTION_CAP).toBeLessThan(FLOOR);
    expect(cappedCeiling).toBeCloseTo(0.58, 10);
    expect(cappedCeiling).toBeGreaterThan(FLOOR);
  });
});
