import { describe, expect, it } from 'vitest';
import { LOW_CONVICTION_CAP } from '../pipeline/analysts/technical-analyst.js';
import { EVIDENCE_WEIGHT } from '../pipeline/debate-engine/conviction-score.js';
import { DEFAULT_TRADER_CONFIG } from '../pipeline/trader/types.js';
import {
  type ConvictionSample,
  type DeskShape,
  enumerateTechnicalLattice,
  type MediatorStance,
  measureConvictionSamples,
  report,
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

    expect(confidences).toEqual([0, 0.25, 0.3333, 0.4, 0.5, 0.6667, 0.75, 1]);
  });

  it('always emits enough key points to saturate the evidence term', () => {
    for (const point of enumerateTechnicalLattice()) {
      expect(point.keyPoints).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('stocks conviction ceiling vs conviction_floor (#756 item 2)', () => {
  it('the production desk shape (sentiment/fundamental absent) clears the floor', () => {
    expect(ceiling('absent', 'agrees')).toBeCloseTo(0.7, 10);
    expect(ceiling('absent', 'agrees')).toBeGreaterThan(FLOOR);
  });

  it('clears strictly — not only on the boundary tie', () => {
    const strict = directional('absent', 'agrees').filter(
      (sample) => sample.conviction > FLOOR && sample.confidence < 1,
    );

    expect(strict.length).toBeGreaterThan(0);
  });

  it('lands EXACTLY on the floor at the weakest directional read (#683 did NOT decide this)', () => {
    const weakest = directional('absent', 'agrees')
      .filter((sample) => sample.clears)
      .reduce((min, sample) => (sample.confidence < min.confidence ? sample : min));

    expect(weakest.confidence).toBeCloseTo(0.25, 10);
    expect(weakest.conviction).toBeCloseTo(FLOOR, 10);
  });

  it('cannot trade against the mediator', () => {
    expect(ceiling('absent', 'opposes')).toBeLessThan(FLOOR);
  });

  it('is diluted, not halted, when sentiment/fundamental return neutral data', () => {
    const hydratedNeutral = ceiling('hydrated-neutral', 'agrees');

    expect(hydratedNeutral).toBeGreaterThan(FLOOR);
    expect(hydratedNeutral).toBeLessThan(ceiling('absent', 'agrees'));
  });

  it('clears on every MI branch once the mediator agrees, at a branch-dependent threshold', () => {
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
    const cappedCeiling = directional('absent', 'agrees')
      .filter((sample) => sample.capped)
      .reduce((max, sample) => Math.max(max, sample.conviction), 0);

    expect(LOW_CONVICTION_CAP).toBeLessThan(FLOOR);
    expect(cappedCeiling).toBeCloseTo(0.58, 10);
    expect(cappedCeiling).toBeGreaterThan(FLOOR);
  });
});

describe("report()'s tie section", () => {
  const CARVE_OUT_POSSIBLE = 'CAN be the #683 carve-out firing';
  const CHECK_SAMPLES = 'check each sample above';
  const CARVE_OUT_EXCLUDED = 'None of these are the #683 carve-out firing';

  function tieCount(floor: number): number {
    return measureConvictionSamples(floor).filter(
      (sample) => sample.direction !== 'neutral' && sample.conviction === floor,
    ).length;
  }

  it('hedges on the carve-out and points at the samples when ties exist below EVIDENCE_WEIGHT', () => {
    expect(tieCount(0.25)).toBeGreaterThan(0);

    const section = report(0.25);

    expect(section).toContain(CARVE_OUT_POSSIBLE);
    expect(section).toContain(CHECK_SAMPLES);
  });

  it('does not point at samples that do not exist when no tie lands on the floor', () => {
    expect(tieCount(0.3)).toBe(0);

    const section = report(0.3);

    expect(section).toContain('samples landing EXACTLY on the floor: 0');
    expect(section).not.toContain(CHECK_SAMPLES);
    expect(section).toContain('No enumerated sample lands exactly on this floor');
  });

  it('excludes the carve-out outright when the floor is above EVIDENCE_WEIGHT', () => {
    expect(tieCount(FLOOR)).toBeGreaterThan(0);
    expect(FLOOR).toBeGreaterThan(EVIDENCE_WEIGHT);

    const section = report(FLOOR);

    expect(section).toContain(CARVE_OUT_EXCLUDED);
    expect(section).not.toContain(CARVE_OUT_POSSIBLE);
  });
});
