/**
 * Measures the STOCKS conviction ceiling on the post-#745 analyst and the
 * converged (#722) RSI, and states it against `DEFAULT_TRADER_CONFIG
 * .conviction_floor` — issue #756 item 2.
 *
 * ## Why this exists
 *
 * #625 measured a stocks conviction ceiling of **0.5478 against a floor of
 * 0.55**: 96 debates, 0 trades, because no stock could clear the floor at any
 * signal strength. That measurement was taken against the pre-#625 conviction
 * formula (spread-between-extremes consensus, absent analysts averaged into
 * evidence) and the pre-#745 technical analyst (scalar `|RSI-50|/50`
 * confidence). BOTH have since been rewritten:
 *
 * - `conviction-score.ts` now uses `|mean|` directional consensus with the
 *   mediator counted as a participant, and EXCLUDES `NO_DATA_MARKER` analysts
 *   from the evidence average (that exclusion is #625 defect 1's stated fix).
 * - `technical-analyst.ts` now emits `confidence = |net| / availableAxes` over
 *   four voting axes, capped at `LOW_CONVICTION_CAP` on a gated tape (#745).
 *
 * So the 0.5478 figure describes a system that no longer exists, and nothing
 * has re-measured since. If the ceiling is still under the floor, a 14-day
 * paper soak produces zero fills and measures nothing — which is why this is a
 * go/no-go rather than a curiosity.
 *
 * ## PASS CRITERION — declared before the measurement was run
 *
 * Fixed in this doc comment and committed BEFORE the first run, so the
 * threshold cannot be back-fitted to whatever came out.
 *
 * - **TOTAL HALT** (report as the same defect #625 reported, do not absorb, do
 *   not fix by lowering the floor): max attainable conviction < 0.55.
 * - **NEAR-HALT**: max attainable conviction >= 0.55, but ONLY at the single
 *   extreme technical confidence 1.0 (all four axes unanimous AND no
 *   volatility cap) — i.e. no lattice point below 1.0 clears.
 * - **CAN TRADE**: max attainable conviction >= 0.55 AND at least one lattice
 *   point with technical confidence < 1.0 clears the floor.
 *
 * ## What "attainable" means here, and what it does NOT mean
 *
 * The measurement is an EXHAUSTIVE ENUMERATION of the reachable input lattice
 * of the current code, not a sample of history. `assessAxes` maps its reads
 * onto at most four unit votes, so `confidence = |net| / availableAxes` is a
 * discrete lattice, and the whole lattice is enumerated by sweeping the real
 * `assessAxes` over a grid that reaches every vote combination. Each attained
 * point is then pushed through the real `computeConvictionScore` on the real
 * production stocks desk shapes.
 *
 * **It therefore reports what CAN clear the floor, not how often anything
 * does.** Realised frequency needs 5m bars on the traded universe, which this
 * repo has no local copy of (`data/samurai-paper.sqlite` holds 21 1h bars per
 * stock, and is pre-#789 anyway, so it is the wrong analyst). That half is
 * stated as unmeasured rather than proxied.
 *
 * ## The four desk shapes
 *
 * A stocks debate runs three analysts. Which branch the other two are on
 * changes the evidence average, and that is exactly the term that produced
 * #625's ceiling, so every reachable shape is reported:
 *
 * - **absent** — sentiment and fundamental both stamp `NO_DATA_MARKER` (the
 *   #436 empty-store branch). This is the shape every debate in the recorded
 *   soak was on. They are excluded from evidence, still counted as neutral
 *   votes in consensus.
 * - **hydrated-split** — fundamental has news items, sentiment has no social
 *   ones. The two read different stores, so this asymmetry is reachable and is
 *   what the current MI stack most likely produces.
 * - **hydrated-neutral** — the MI store returns items, both read neutral at
 *   the `confidenceFrom` floor 0.05. They now DILUTE the evidence average.
 * - **hydrated-aligned** — both read the technical direction at the
 *   `confidenceFrom` ceiling 0.95.
 *
 * ## Two gates this measurement is NOT about
 *
 * - `routeDecision` skips at `neutral_direction_while_flat` BEFORE the floor is
 *   ever consulted (`decide.ts`), and in #625's recorded data that was 265 of
 *   268 skips against 3 at the floor. Clearing the floor is necessary, not
 *   sufficient.
 * - `applyAnalystWeights` (`weighted-conviction.ts`) scales the conviction the
 *   Trader gates on by `weightedAgreement / unweightedAgreement`, clamped to
 *   [0, 1], AFTER `runDebate`. Every `analyst_weights` row currently sits at
 *   1.0 (no closed trades), which makes that factor exactly 1, so the numbers
 *   here are the numbers the gate sees today — but they are not invariant to a
 *   feedback loop that has started moving weights.
 *
 * The mediator's verdict is a participant in the consensus term, and it is LLM
 * output that cannot be enumerated offline, so every desk shape is reported
 * against all three mediator stances (agrees / neutral / opposes).
 *
 * Usage: `yarn build && node dist/server/tools/measure-conviction-ceiling.js`
 * (or `yarn tsx server/tools/measure-conviction-ceiling.ts`). No network, no
 * keys, no database — pure functions over an enumerated grid.
 */

import {
  type AxisAssessment,
  assessAxes,
  LOW_CONVICTION_CAP,
} from '../pipeline/analysts/technical-analyst.js';
import { NO_DATA_MARKER } from '../pipeline/analysts/types.js';
import { computeConvictionScore } from '../pipeline/debate-engine/conviction-score.js';
import type { AnalystView, Direction } from '../pipeline/debate-engine/types.js';
import { DEFAULT_TRADER_CONFIG } from '../pipeline/trader/types.js';

/** Which branch the sentiment/fundamental pair is on for a given debate. */
export type DeskShape = 'absent' | 'hydrated-split' | 'hydrated-neutral' | 'hydrated-aligned';

export const DESK_SHAPES: readonly DeskShape[] = [
  'absent',
  'hydrated-split',
  'hydrated-neutral',
  'hydrated-aligned',
];

/** The mediator's verdict relative to the technical analyst's direction. */
export type MediatorStance = 'agrees' | 'neutral' | 'opposes';

export const MEDIATOR_STANCES: readonly MediatorStance[] = ['agrees', 'neutral', 'opposes'];

/** `confidenceFrom`'s clamp bounds in both the sentiment and fundamental analysts. */
const MI_CONFIDENCE_FLOOR = 0.05;
const MI_CONFIDENCE_CEILING = 0.95;

/**
 * The key points `technical-analyst.ts` appends beyond one line per axis
 * reading: the gate line, the axis-vote summary, the session-VWAP line, the 1h
 * context line and the MI-context line. Unavailability lines are additional, so
 * this is the FLOOR on the count, which is what matters — `KEY_POINTS_SATURATION`
 * is 3 and even a two-axis view carries 2 + 5 = 7.
 */
const TECHNICAL_FIXED_KEY_POINTS = 5;

/** Sentiment and fundamental each emit exactly two key points. */
const MI_ANALYST_KEY_POINTS = 2;

/** One enumerated point of the technical analyst's reachable output. */
export interface LatticePoint {
  direction: Direction;
  confidence: number;
  availableAxes: number;
  net: number;
  capped: boolean;
  keyPoints: number;
}

/**
 * Sweeps the REAL `assessAxes` over a grid that reaches every vote combination
 * and returns the distinct outputs.
 *
 * The grid is over indicator VALUES rather than votes on purpose: the vote
 * rules (`trendVote`, `momentumVote`, `participationVote`, `structureVote`, the
 * ADX/squeeze cap) are the thing under measurement, so restating them here
 * would measure this file instead of the analyst.
 */
export function enumerateTechnicalLattice(): LatticePoint[] {
  const sma = 100;
  const closes = [101, 100, 99];
  const rsis = [5, 25, 45, 50, 55, 75, 95];
  const macds: (number | undefined)[] = [undefined, -1, 0, 1];
  const participations: (number | null | undefined)[] = [undefined, null, 0.9, 0.5, 0.1];
  const donchians: (number | undefined)[] = [undefined, 0.9, 0.5, 0.1];
  const adxs: (number | undefined)[] = [undefined, 10, 30];
  const squeezes: (number | undefined)[] = [undefined, 0.5, 1.5];

  const seen = new Map<string, LatticePoint>();

  for (const lastClose of closes) {
    for (const rsi of rsis) {
      for (const macd of macds) {
        for (const participation of participations) {
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

/** The three-analyst stocks desk as production builds it, for one desk shape. */
export function buildStocksDesk(point: LatticePoint, shape: DeskShape): AnalystView[] {
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
      // The two analysts read DIFFERENT stores — fundamental takes
      // `marketContext.news`, sentiment takes social — so they hydrate
      // independently and the desk can sit with one on each branch. This is
      // the shape the current MI stack most likely produces (`yarn smoke`
      // serves news items and no social ones).
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

/** One measured conviction for one lattice point, desk shape and mediator stance. */
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
        // `roundStances` is empty: the production adapter echoes each view's own
        // direction as its round stance, and `finalPositionFor` falls back to
        // `view.direction`, so an empty list is the same input the live path
        // supplies. The mediator verdict is the third argument, exactly as
        // `debate-adapter.ts` passes `response.stance`.
        const conviction = computeConvictionScore(views, [], mediatorVerdict(point, mediator));
        samples.push({
          ...point,
          shape,
          mediator,
          conviction,
          // The Trader gates on `debate.confidence < conviction_floor`
          // (`decide.ts`), so an exact tie at the floor is NOT skipped — it
          // trades. That strict comparison is #683 and is deliberately
          // reproduced rather than corrected here.
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
  lines.push('');

  lines.push('## Gated tape (`LOW_CONVICTION_CAP` = 0.4) — #756 item 3');
  lines.push('');
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
  lines.push('');

  lines.push('## Exact ties at the floor — #683 is load-bearing');
  lines.push('');
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
  lines.push(
    'These trade only because the gate is `debate.confidence < conviction_floor` (strict). ' +
      'Under `<=` they would all skip — so #683 is not a curiosity here, it decides whether ' +
      'the weakest directional read on the production desk shape trades at all.',
  );
  lines.push('');

  const belowOne = samples.filter(
    (sample) => sample.clears && sample.confidence < 1 && sample.direction !== 'neutral',
  );
  const verdict =
    overallCeiling < floor
      ? 'TOTAL HALT — no stock can clear the floor at any signal strength'
      : belowOne.length === 0
        ? 'NEAR-HALT — only a unanimous, uncapped four-axis read clears'
        : 'CAN TRADE — points below maximum technical confidence clear the floor';

  lines.push('## Verdict against the pre-declared criterion');
  lines.push('');
  lines.push(`overall ceiling: ${format(overallCeiling)} vs floor ${format(floor)}`);
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

// Matches both the built entry point and a `tsx` run of the source, so the
// report is reachable without a full `yarn build`.
if (/measure-conviction-ceiling\.(js|ts)$/.test(process.argv[1] ?? '')) {
  console.log(report(DEFAULT_TRADER_CONFIG.conviction_floor));
}
