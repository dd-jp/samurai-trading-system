import {
  type AxisAssessment,
  assessAxes,
  LOW_CONVICTION_CAP,
  NO_DATA_MARKER,
} from '../pipeline/analysts/index.js';
import type { AnalystView, Direction } from '../pipeline/debate-engine/index.js';
import { computeConvictionScore, EVIDENCE_WEIGHT } from '../pipeline/debate-engine/index.js';
import { DEFAULT_TRADER_CONFIG } from '../pipeline/trader/index.js';

export type DeskShape = 'absent' | 'hydrated-split' | 'hydrated-neutral' | 'hydrated-aligned';

const DESK_SHAPES: readonly DeskShape[] = [
  'absent',
  'hydrated-split',
  'hydrated-neutral',
  'hydrated-aligned',
];

export type MediatorStance = 'agrees' | 'neutral' | 'opposes';

const MEDIATOR_STANCES: readonly MediatorStance[] = ['agrees', 'neutral', 'opposes'];

const MI_CONFIDENCE_FLOOR = 0.05;
const MI_CONFIDENCE_CEILING = 0.95;

const TECHNICAL_FIXED_KEY_POINTS = 5;

const MI_ANALYST_KEY_POINTS = 2;

export interface LatticePoint {
  direction: Direction;
  confidence: number;
  availableAxes: number;
  net: number;
  capped: boolean;
  keyPoints: number;
}

function collectLatticePointsFor(
  lastClose: number,
  rsi: number,
  macd: number | undefined,
  participation: number | null | undefined,
  seen: Map<string, LatticePoint>,
): void {
  const sma = 100;
  const donchians: (number | undefined)[] = [undefined, 0.9, 0.5, 0.1];
  const adxs: (number | undefined)[] = [undefined, 10, 30];
  const squeezes: (number | undefined)[] = [undefined, 0.5, 1.5];

  for (const donchian of donchians) {
    for (const adx of adxs) {
      for (const squeeze of squeezes) {
        const assessment: AxisAssessment = assessAxes(
          { lastClose, sma, rsi, atrPct: 1 },
          { macd, adx, squeeze, donchian, participation },
        );
        const point: LatticePoint = {
          direction: assessment.direction,
          confidence: assessment.confidence,
          availableAxes: assessment.availableAxes,
          net: assessment.net,
          capped: assessment.capReasons.length > 0,
          keyPoints: assessment.readings.length + TECHNICAL_FIXED_KEY_POINTS,
        };
        const key = `${point.direction}|${point.confidence}|${point.availableAxes}|${point.capped}|${point.keyPoints}`;
        if (!seen.has(key)) seen.set(key, point);
      }
    }
  }
}

export function enumerateTechnicalLattice(): LatticePoint[] {
  const closes = [101, 100, 99];
  const rsis = [5, 25, 45, 50, 55, 75, 95];
  const macds: (number | undefined)[] = [undefined, -1, 0, 1];
  const participations: (number | null | undefined)[] = [undefined, null, 0.9, 0.5, 0.1];

  const seen = new Map<string, LatticePoint>();

  for (const lastClose of closes) {
    for (const rsi of rsis) {
      for (const macd of macds) {
        for (const participation of participations) {
          collectLatticePointsFor(lastClose, rsi, macd, participation, seen);
        }
      }
    }
  }

  return [...seen.values()].sort(
    (a, b) => a.confidence - b.confidence || a.availableAxes - b.availableAxes,
  );
}

const TIMESTAMP = new Date('2026-08-18T00:00:00.000Z');

function view(
  analyst_id: string,
  direction: Direction,
  confidence: number,
  keyPoints: string[],
): AnalystView {
  return {
    trace_id: 'measure-conviction-ceiling',
    analyst_id,
    analyst_type: analyst_id,
    direction,
    confidence,
    key_points: keyPoints,
    timestamp: TIMESTAMP,
  };
}

function filler(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix} key point ${index + 1}`);
}

function buildStocksDesk(point: LatticePoint, shape: DeskShape): AnalystView[] {
  const technical = view(
    'technical',
    point.direction,
    point.confidence,
    filler(point.keyPoints, 'technical'),
  );

  const absent = (id: string): AnalystView =>
    view(id, 'neutral', MI_CONFIDENCE_FLOOR, [
      `${NO_DATA_MARKER}: the market-intelligence store returned nothing for this window.`,
      `${id} secondary line`,
    ]);

  switch (shape) {
    case 'absent':
      return [technical, absent('sentiment'), absent('fundamental')];
    case 'hydrated-split':
      return [
        technical,
        absent('sentiment'),
        view('fundamental', 'neutral', MI_CONFIDENCE_FLOOR, filler(MI_ANALYST_KEY_POINTS, 'fund')),
      ];
    case 'hydrated-neutral':
      return [
        technical,
        view('sentiment', 'neutral', MI_CONFIDENCE_FLOOR, filler(MI_ANALYST_KEY_POINTS, 'sent')),
        view('fundamental', 'neutral', MI_CONFIDENCE_FLOOR, filler(MI_ANALYST_KEY_POINTS, 'fund')),
      ];
    case 'hydrated-aligned':
      return [
        technical,
        view(
          'sentiment',
          point.direction,
          MI_CONFIDENCE_CEILING,
          filler(MI_ANALYST_KEY_POINTS, 'sent'),
        ),
        view(
          'fundamental',
          point.direction,
          MI_CONFIDENCE_CEILING,
          filler(MI_ANALYST_KEY_POINTS, 'fund'),
        ),
      ];
  }
}

function mediatorVerdict(point: LatticePoint, stance: MediatorStance): Direction {
  if (stance === 'neutral' || point.direction === 'neutral') return 'neutral';
  if (stance === 'agrees') return point.direction;
  return point.direction === 'bullish' ? 'bearish' : 'bullish';
}

export interface ConvictionSample extends LatticePoint {
  shape: DeskShape;
  mediator: MediatorStance;
  conviction: number;
  clears: boolean;
}

export function measureConvictionSamples(floor: number): ConvictionSample[] {
  const samples: ConvictionSample[] = [];

  for (const point of enumerateTechnicalLattice()) {
    for (const shape of DESK_SHAPES) {
      for (const mediator of MEDIATOR_STANCES) {
        const views = buildStocksDesk(point, shape);
        const conviction = computeConvictionScore(views, [], mediatorVerdict(point, mediator));
        samples.push({
          ...point,
          shape,
          mediator,
          conviction,
          clears: !(conviction < floor),
        });
      }
    }
  }

  return samples;
}

function format(value: number): string {
  return value.toFixed(4);
}

function buildCeilingTable(
  samples: readonly ConvictionSample[],
  floor: number,
): { lines: string[]; overallCeiling: number } {
  const lines: string[] = [];
  let overallCeiling = 0;
  for (const shape of DESK_SHAPES) {
    for (const mediator of MEDIATOR_STANCES) {
      const subset = samples.filter(
        (sample) =>
          sample.shape === shape && sample.mediator === mediator && sample.direction !== 'neutral',
      );
      const ceiling = subset.reduce((max, sample) => Math.max(max, sample.conviction), 0);
      overallCeiling = Math.max(overallCeiling, ceiling);
      const clearing = subset.filter((sample) => sample.clears);
      const minClearing =
        clearing.length === 0
          ? 'none'
          : format(clearing.reduce((min, s) => Math.min(min, s.confidence), 1));
      lines.push(
        `| ${shape} | ${mediator} | ${format(ceiling)} | ${ceiling >= floor ? 'YES' : 'NO'} | ${minClearing} |`,
      );
    }
  }
  return { lines, overallCeiling };
}

function buildGatedTapeSection(samples: readonly ConvictionSample[], floor: number): string[] {
  const lines: string[] = [];
  for (const shape of DESK_SHAPES) {
    const capped = samples.filter(
      (sample) =>
        sample.shape === shape &&
        sample.mediator === 'agrees' &&
        sample.capped &&
        sample.direction !== 'neutral',
    );
    const ceiling = capped.reduce((max, sample) => Math.max(max, sample.conviction), 0);
    lines.push(
      `- ${shape}, mediator agrees: capped-tape ceiling ${format(ceiling)} — ` +
        `${ceiling >= floor ? 'STILL CLEARS the floor' : 'below the floor'}`,
    );
  }
  return lines;
}

function buildTiesSection(samples: readonly ConvictionSample[], floor: number): string[] {
  const lines: string[] = [];
  const ties = samples.filter(
    (sample) => sample.direction !== 'neutral' && sample.conviction === floor,
  );
  const tieShapes = [
    ...new Set(
      ties.map((tie) => `${tie.shape}/${tie.mediator} at technical ${format(tie.confidence)}`),
    ),
  ].sort();
  lines.push(`samples landing EXACTLY on the floor: ${ties.length}`);
  for (const shape of tieShapes) lines.push(`- ${shape}`);
  if (ties.length === 0) {
    lines.push(
      `No enumerated sample lands exactly on this floor (${format(floor)}), so across THIS ` +
        'enumeration `<` and `<=` admit the same set. Whether the boundary itself should count ' +
        'as clearing is a separate, still-open question (#756 item 1), not one #683 decided.',
    );
  } else {
    lines.push(
      'These trade only because the gate is `debate.confidence < conviction_floor` (strict, ' +
        '`decide.ts`, predates #683). Under `<=` they would all skip.' +
        (floor > EVIDENCE_WEIGHT
          ? ' None of these are the #683 carve-out firing: that carve-out forces the consensus ' +
            `term to 0, capping conviction at \`EVIDENCE_WEIGHT\` (${format(EVIDENCE_WEIGHT)}) — ` +
            `below this floor (${format(floor)}), so a sample landing ON the floor necessarily has ` +
            'a non-zero analyst mean.'
          : ` This floor (${format(floor)}) is at or below \`EVIDENCE_WEIGHT\` ` +
            `(${format(EVIDENCE_WEIGHT)}), so a tie here CAN be the #683 carve-out firing — check ` +
            'each sample above before assuming otherwise.') +
        ' Whether the boundary itself should count as clearing is a separate, still-open question ' +
        '(#756 item 1), not one #683 decided.',
    );
  }
  return lines;
}

function computeVerdict(overallCeiling: number, floor: number, belowOneCount: number): string {
  if (overallCeiling < floor) {
    return 'TOTAL HALT — no stock can clear the floor at any signal strength';
  }
  if (belowOneCount === 0) {
    return 'NEAR-HALT — only a unanimous, uncapped four-axis read clears';
  }
  return 'CAN TRADE — points below maximum technical confidence clear the floor';
}

export function report(floor: number): string {
  const samples = measureConvictionSamples(floor);
  const lines: string[] = [];

  lines.push('# Stocks conviction ceiling vs conviction_floor (#756 item 2)');
  lines.push('');
  lines.push(`conviction_floor (DEFAULT_TRADER_CONFIG): ${format(floor)}`);
  lines.push(`LOW_CONVICTION_CAP (technical, gated tape): ${format(LOW_CONVICTION_CAP)}`);
  lines.push(`#625 measured ceiling, pre-#625 formula / pre-#745 analyst: 0.5478`);
  lines.push('');

  const lattice = enumerateTechnicalLattice();
  const confidences = [...new Set(lattice.map((point) => point.confidence))].sort((a, b) => a - b);
  lines.push('## Technical confidence lattice (real `assessAxes`, exhaustive grid)');
  lines.push('');
  lines.push(`distinct outputs: ${lattice.length}`);
  lines.push(`distinct confidences: ${confidences.map(format).join(', ')}`);
  lines.push(
    `available-axis counts: ${[...new Set(lattice.map((p) => p.availableAxes))].sort().join(', ')}`,
  );
  lines.push(
    `key-point counts (saturation is 3): ${[...new Set(lattice.map((p) => p.keyPoints))].sort((a, b) => a - b).join(', ')}`,
  );
  lines.push('');

  lines.push('## Ceiling per desk shape and mediator stance');
  lines.push('');
  lines.push(
    '| desk shape | mediator | ceiling | clears 0.55? | min technical confidence clearing |',
  );
  lines.push('| --- | --- | --- | --- | --- |');

  const ceilingTable = buildCeilingTable(samples, floor);
  lines.push(...ceilingTable.lines);
  lines.push('');

  lines.push('## Gated tape (`LOW_CONVICTION_CAP` = 0.4) — #756 item 3');
  lines.push('');
  lines.push(...buildGatedTapeSection(samples, floor));
  lines.push('');

  lines.push('## Exact ties at the floor — what the strict `<` gate admits');
  lines.push('');
  lines.push(...buildTiesSection(samples, floor));
  lines.push('');

  const belowOne = samples.filter(
    (sample) => sample.clears && sample.confidence < 1 && sample.direction !== 'neutral',
  );
  const verdict = computeVerdict(ceilingTable.overallCeiling, floor, belowOne.length);

  lines.push('## Verdict against the pre-declared criterion');
  lines.push('');
  lines.push(`overall ceiling: ${format(ceilingTable.overallCeiling)} vs floor ${format(floor)}`);
  lines.push(`clearing points with technical confidence < 1.0: ${belowOne.length}`);
  lines.push(`VERDICT: ${verdict}`);
  lines.push('');
  lines.push(
    'NOT MEASURED: how OFTEN a live tape lands on a clearing point. That needs 5m bars on the ' +
      'traded universe, which this repo holds no local copy of, and the recorded soak database ' +
      'is pre-#789 (the wrong analyst). See this file’s doc comment.',
  );

  return lines.join('\n');
}

if (/measure-conviction-ceiling\.(js|ts)$/.test(process.argv[1] ?? '')) {
  console.log(report(DEFAULT_TRADER_CONFIG.conviction_floor));
}
