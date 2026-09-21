import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import type {
  AnalystContribution,
  AnalystView,
  DebateResult,
  Direction,
} from '../pipeline/debate-engine/index.js';
import {
  applyAnalystWeights,
  computeConvictionScore,
  EVIDENCE_WEIGHT,
} from '../pipeline/debate-engine/index.js';
import { DEFAULT_TRADER_CONFIG } from '../pipeline/trader/index.js';
import { isMainModule } from './cli-entrypoint.js';

const CONSENSUS_WEIGHT = 1 - EVIDENCE_WEIGHT;
const REPLAY_TOLERANCE = 1e-9;
const MEDIATOR_PROMPT_PREFIX = 'You are the Mediator persona';

const DIRECTION_VALUE: Record<Direction, number> = { bearish: -1, neutral: 0, bullish: 1 };

export interface DebateRow {
  debate_id: string;
  instrument: string;
  bar_timestamp: string;
  direction: Direction;
  confidence: number;
  contributions_json: string;
  created_at: string;
}

export interface WeightAdjustment {
  analyst_id: string;
  to_value: number;
  created_at: string;
}

type Contribution = AnalystContribution;

export type FormulaMatch = 'current' | 'pre-683-only' | 'neither' | 'not-captured';

export interface ReplayedDebate {
  row: DebateRow;
  desk: string;
  analystMean: number;
  captured: boolean;
  replayedCurrent: number | null;
  replayedPre683: number | null;
  match: FormulaMatch;
  evidence: number | null;
  evidenceOnlyFeasiblePre683: boolean;
  evidenceEraAmbiguous: boolean;
  technicalConfidence: number | null;
  fundamentalConfidence: number | null;
  convictionIfMediatorSidedWithDesk: number | null;
}

export function resolveReadOnlyDbPath(raw: string): string {
  if (!raw.startsWith('file:')) return raw;
  const url = new URL(raw);
  const mode = url.searchParams.get('mode');
  if (mode !== null && mode !== 'ro') {
    throw new Error(`replay-debate-conviction opens the store read-only; got mode=${mode}.`);
  }
  url.search = '';
  return fileURLToPath(url);
}

export function parseCapturedViews(prompt: string): AnalystView[] | null {
  const contextAt = prompt.lastIndexOf('\nContext:\n');
  if (contextAt === -1) return null;
  const jsonStart = prompt.indexOf('{', contextAt);
  const jsonEnd = prompt.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd < jsonStart) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt.slice(jsonStart, jsonEnd + 1));
  } catch {
    return null;
  }
  const views = (parsed as { analyst_views?: unknown }).analyst_views;
  if (!Array.isArray(views) || views.length === 0) return null;

  return views.map((view) => {
    const candidate = view as AnalystView & { timestamp: string };
    return { ...candidate, timestamp: new Date(candidate.timestamp) };
  });
}

export function directionalConsensusPre683(positions: Direction[], verdict: Direction): number {
  const values = [...positions, verdict].map((direction) => DIRECTION_VALUE[direction]);
  return Math.abs(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function directionalConsensusCurrent(positions: Direction[], verdict: Direction): number {
  const analystSum = positions.reduce((sum, direction) => sum + DIRECTION_VALUE[direction], 0);
  if (analystSum === 0) return 0;
  return directionalConsensusPre683(positions, verdict);
}

export function weightsAt(
  adjustments: readonly WeightAdjustment[],
  at: string,
): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const adjustment of adjustments) {
    if (adjustment.created_at <= at) weights[adjustment.analyst_id] = adjustment.to_value;
  }
  return weights;
}

function weighted(
  confidence: number,
  contributions: Contribution[],
  direction: Direction,
  weights: Record<string, number>,
): number {
  return applyAnalystWeights({ confidence, contributions, direction } as DebateResult, weights)
    .confidence;
}

export function technicalConfidenceFromRationale(contributions: Contribution[]): number | null {
  const rationale = contributions.find((c) => c.analyst_id === 'technical')?.rationale ?? '';
  const match = /available axes, confidence ([0-9.]+)/.exec(rationale);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function signOf(value: number): Direction {
  if (value > 0) return 'bullish';
  if (value < 0) return 'bearish';
  return 'neutral';
}

function classifyMatch(persisted: number, current: number, pre683: number): FormulaMatch {
  if (Math.abs(persisted - current) <= REPLAY_TOLERANCE) return 'current';
  if (Math.abs(persisted - pre683) <= REPLAY_TOLERANCE) return 'pre-683-only';
  return 'neither';
}

function isFeasibleEvidence(evidence: number): boolean {
  return evidence >= 0 && evidence <= 1;
}

function impliedEvidence(
  row: DebateRow,
  contributions: Contribution[],
  positions: Direction[],
  weights: Record<string, number>,
): { evidence: number | null; onlyFeasiblePre683: boolean; eraAmbiguous: boolean } {
  const unweighted = row.confidence / weighted(1, contributions, row.direction, weights);
  const impliedUnder = (directional: number): number =>
    (unweighted - CONSENSUS_WEIGHT * directional) / EVIDENCE_WEIGHT;
  const current = impliedUnder(directionalConsensusCurrent(positions, row.direction));
  const pre683 = impliedUnder(directionalConsensusPre683(positions, row.direction));
  const erasAgree = Math.abs(current - pre683) <= REPLAY_TOLERANCE;

  if (isFeasibleEvidence(current) && (erasAgree || !isFeasibleEvidence(pre683))) {
    return { evidence: current, onlyFeasiblePre683: false, eraAmbiguous: false };
  }
  if (isFeasibleEvidence(current)) {
    return { evidence: null, onlyFeasiblePre683: false, eraAmbiguous: true };
  }
  return isFeasibleEvidence(pre683)
    ? { evidence: pre683, onlyFeasiblePre683: true, eraAmbiguous: false }
    : { evidence: null, onlyFeasiblePre683: false, eraAmbiguous: false };
}

export function replayDebate(
  row: DebateRow,
  views: AnalystView[] | null,
  weights: Record<string, number>,
): ReplayedDebate | null {
  const contributions = JSON.parse(row.contributions_json) as Contribution[];
  if (contributions.length === 0) return null;

  const positions = contributions.map((contribution) => contribution.final_position);
  const analystMean =
    positions.reduce((sum, direction) => sum + DIRECTION_VALUE[direction], 0) / positions.length;
  const desk = contributions
    .map((contribution) => `${contribution.analyst_id}=${contribution.final_position}`)
    .join(' ');
  const deskSide = signOf(analystMean);

  if (views === null) {
    const implied = impliedEvidence(row, contributions, positions, weights);
    return {
      row,
      desk,
      analystMean,
      captured: false,
      replayedCurrent: null,
      replayedPre683: null,
      match: 'not-captured',
      evidence: implied.evidence,
      evidenceOnlyFeasiblePre683: implied.onlyFeasiblePre683,
      evidenceEraAmbiguous: implied.eraAmbiguous,
      technicalConfidence: technicalConfidenceFromRationale(contributions),
      fundamentalConfidence: null,
      convictionIfMediatorSidedWithDesk:
        implied.evidence === null || deskSide === 'neutral'
          ? null
          : weighted(
              CONSENSUS_WEIGHT * directionalConsensusCurrent(positions, deskSide) +
                EVIDENCE_WEIGHT * implied.evidence,
              contributions,
              deskSide,
              weights,
            ),
    };
  }

  const replayedCurrent = weighted(
    computeConvictionScore(views, [], row.direction),
    contributions,
    row.direction,
    weights,
  );
  const evidence =
    (computeConvictionScore(views, [], row.direction) -
      CONSENSUS_WEIGHT * directionalConsensusCurrent(positions, row.direction)) /
    EVIDENCE_WEIGHT;
  const replayedPre683 = weighted(
    CONSENSUS_WEIGHT * directionalConsensusPre683(positions, row.direction) +
      EVIDENCE_WEIGHT * evidence,
    contributions,
    row.direction,
    weights,
  );
  const confidenceOf = (analyst_id: string): number | null =>
    views.find((view) => view.analyst_id === analyst_id)?.confidence ?? null;

  return {
    row,
    desk,
    analystMean,
    captured: true,
    replayedCurrent,
    replayedPre683,
    match: classifyMatch(row.confidence, replayedCurrent, replayedPre683),
    evidence,
    evidenceOnlyFeasiblePre683: false,
    evidenceEraAmbiguous: false,
    technicalConfidence: confidenceOf('technical'),
    fundamentalConfidence: confidenceOf('fundamental'),
    convictionIfMediatorSidedWithDesk:
      deskSide === 'neutral'
        ? null
        : weighted(computeConvictionScore(views, [], deskSide), contributions, deskSide, weights),
  };
}

function format(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4);
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function numbers(values: (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null);
}

const TECHNICAL_CONFIDENCE_BANDS: readonly (readonly [string, number, number])[] = [
  ['<= 0.40', -1, 0.4],
  ['0.40 - 0.75', 0.4, 0.75],
  ['> 0.75', 0.75, 1],
];

function deskVerdictTable(debates: ReplayedDebate[], floor: number): string[] {
  const groups = new Map<string, ReplayedDebate[]>();
  for (const debate of debates) {
    const key = `${debate.desk} | ${debate.row.direction}`;
    groups.set(key, [...(groups.get(key) ?? []), debate]);
  }
  const lines = [
    '| desk (final positions) | mediator verdict | n | min conviction | max conviction | n >= floor |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const [key, members] of [...groups.entries()].sort()) {
    const convictions = members.map((member) => member.row.confidence);
    lines.push(
      `| ${key} | ${members.length} | ${format(Math.min(...convictions))} | ` +
        `${format(Math.max(...convictions))} | ` +
        `${convictions.filter((conviction) => conviction >= floor).length} |`,
    );
  }
  return lines;
}

function leaningDeskSection(debates: ReplayedDebate[], side: Direction, floor: number): string[] {
  const leaning = debates.filter(
    (debate) =>
      debate.analystMean !== 0 &&
      signOf(debate.analystMean) === side &&
      debate.desk.includes(`technical=${side}`),
  );
  const agreed = leaning.filter((debate) => debate.row.direction === side);
  const counterfactual = numbers(leaning.map((d) => d.convictionIfMediatorSidedWithDesk));

  return [
    `### technical=${side}, desk net ${side}`,
    '',
    `desks: ${leaning.length}; mediator verdict ${side}: ${agreed.length}; ` +
      `neutral: ${leaning.filter((d) => d.row.direction === 'neutral').length}`,
    `persisted conviction >= ${floor}: ${leaning.filter((d) => d.row.direction === side && d.row.confidence >= floor).length}`,
    `conviction had the mediator sided with the desk: min ${format(counterfactual.length === 0 ? null : Math.min(...counterfactual))}, ` +
      `max ${format(counterfactual.length === 0 ? null : Math.max(...counterfactual))}, ` +
      `>= ${floor}: ${counterfactual.filter((value) => value >= floor).length} of ${counterfactual.length}`,
    `mean evidence strength: ${format(mean(numbers(leaning.map((d) => d.evidence))))}`,
    `mean fundamental confidence, captured views only: ${format(mean(numbers(leaning.map((d) => d.fundamentalConfidence))))} ` +
      `(n=${leaning.filter((d) => d.captured).length})`,
    '',
    '| technical confidence | desks | mediator sided with desk |',
    '| --- | --- | --- |',
    ...TECHNICAL_CONFIDENCE_BANDS.map(([label, low, high]) => {
      const band = leaning.filter(
        (d) =>
          d.technicalConfidence !== null &&
          d.technicalConfidence > low &&
          d.technicalConfidence <= high,
      );
      return `| ${label} | ${band.length} | ${band.filter((d) => d.row.direction === side).length} |`;
    }),
    '',
  ];
}

function fundamentalSection(debates: ReplayedDebate[]): string[] {
  const fundamentalOf = (debate: ReplayedDebate): Contribution | undefined =>
    (JSON.parse(debate.row.contributions_json) as Contribution[]).find(
      (contribution) => contribution.analyst_id === 'fundamental',
    );
  const count = (direction: Direction): number =>
    debates.filter((debate) => fundamentalOf(debate)?.final_position === direction).length;

  const byBar = new Map<string, Set<string>>();
  const barSizes = new Map<string, number>();
  for (const debate of debates) {
    const headline = fundamentalOf(debate)?.rationale.split('; ')[0] ?? '';
    const bar = debate.row.bar_timestamp;
    byBar.set(bar, new Set([...(byBar.get(bar) ?? []), headline]));
    barSizes.set(bar, (barSizes.get(bar) ?? 0) + 1);
  }
  const multiInstrumentBars = [...barSizes.entries()].filter(([, size]) => size > 1);
  const identical = multiInstrumentBars.filter(([bar]) => byBar.get(bar)?.size === 1);

  const technicalBullish = debates.filter((debate) => debate.desk.includes('technical=bullish'));
  const technicalBearish = debates.filter((debate) => debate.desk.includes('technical=bearish'));
  const agreeing = (group: ReplayedDebate[], side: Direction): number =>
    group.filter((debate) => debate.desk.includes(`fundamental=${side}`)).length;

  return [
    `fundamental final position: bearish ${count('bearish')}, bullish ${count('bullish')}, neutral ${count('neutral')}`,
    `technical=bullish desks: ${technicalBullish.length}; fundamental agrees on ${agreeing(technicalBullish, 'bullish')}, opposes on ${agreeing(technicalBullish, 'bearish')}`,
    `technical=bearish desks: ${technicalBearish.length}; fundamental agrees on ${agreeing(technicalBearish, 'bearish')}, opposes on ${agreeing(technicalBearish, 'bullish')}`,
    `bars debating more than one instrument: ${multiInstrumentBars.length}; fundamental headline line identical across every instrument on ${identical.length} of them`,
  ];
}

export function buildReport(debates: ReplayedDebate[], emptyRows: number, floor: number): string {
  const lines: string[] = ['# debate_log conviction replay', ''];
  const byVerdict = (direction: Direction): ReplayedDebate[] =>
    debates.filter((debate) => debate.row.direction === direction);

  lines.push(`conviction_floor: ${floor}`);
  lines.push(`debate_log rows: ${debates.length + emptyRows}`);
  lines.push(`rows with no contributions (debate never ran; confidence 0): ${emptyRows}`);
  lines.push(`debates that ran: ${debates.length}`);
  for (const direction of ['bullish', 'bearish', 'neutral'] as const) {
    const convictions = byVerdict(direction).map((debate) => debate.row.confidence);
    lines.push(
      `  ${direction}: n=${convictions.length} mean=${format(mean(convictions))} ` +
        `max=${format(convictions.length === 0 ? null : Math.max(...convictions))} ` +
        `>= floor: ${convictions.filter((conviction) => conviction >= floor).length}`,
    );
  }
  lines.push('');

  const captured = debates.filter((debate) => debate.captured);
  lines.push('## Exact replay through computeConvictionScore (views captured in llm_call_log)');
  lines.push('');
  lines.push(`captured: ${captured.length} of ${debates.length}`);
  for (const match of ['current', 'pre-683-only', 'neither'] as const) {
    lines.push(`  persisted == ${match}: ${captured.filter((d) => d.match === match).length}`);
  }
  const uncaptured = debates.filter((debate) => !debate.captured);
  lines.push(
    `not captured: ${uncaptured.length}; implied evidence in [0,1] under current or pre-#683 consensus: ` +
      `${uncaptured.filter((debate) => debate.evidence !== null).length}; ` +
      `feasible only under pre-#683: ${uncaptured.filter((debate) => debate.evidenceOnlyFeasiblePre683).length}; ` +
      `feasible under both with different values (evidence left unset): ${uncaptured.filter((debate) => debate.evidenceEraAmbiguous).length}`,
  );
  lines.push('');

  lines.push('## Desk shape by mediator verdict');
  lines.push('');
  lines.push(...deskVerdictTable(debates, floor));
  lines.push('');

  lines.push('## Bullish verdicts');
  lines.push('');
  const bullish = byVerdict('bullish');
  const splitDesk = bullish.filter((debate) => debate.analystMean === 0);
  const bullishEvidence = numbers(bullish.map((debate) => debate.evidence));
  lines.push(`bullish verdicts: ${bullish.length}; on a desk netting to zero: ${splitDesk.length}`);
  lines.push(
    `evidence strength on those rows: min ${format(Math.min(...bullishEvidence))}, max ${format(Math.max(...bullishEvidence))}`,
  );
  lines.push(
    `zero-net desk ceiling at evidence 1: pre-#683 ${format(CONSENSUS_WEIGHT * directionalConsensusPre683(['bullish', 'bearish', 'neutral'], 'bullish') + EVIDENCE_WEIGHT)}, ` +
      `current ${format(EVIDENCE_WEIGHT)}`,
  );
  lines.push('');

  lines.push(
    '## Desks leaning one way: what the mediator did, and what agreement would have scored',
  );
  lines.push('');
  lines.push(...leaningDeskSection(debates, 'bullish', floor));
  lines.push(...leaningDeskSection(debates, 'bearish', floor));

  lines.push('## Fundamental analyst input');
  lines.push('');
  lines.push(...fundamentalSection(debates));

  return lines.join('\n');
}

export function loadAndReplay(dbPath: string): { debates: ReplayedDebate[]; emptyRows: number } {
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT debate_id, instrument, bar_timestamp, direction, confidence, contributions_json,
                created_at
           FROM debate_log ORDER BY created_at, debate_id`,
      )
      .all() as DebateRow[];
    const adjustments = db
      .prepare(
        `SELECT dial_name AS analyst_id, to_value, created_at FROM dial_adjustments
          WHERE dial_type = 'analyst_weight' AND status = 'applied' ORDER BY created_at, id`,
      )
      .all() as WeightAdjustment[];
    const promptFor = db.prepare(
      `SELECT prompt FROM llm_call_log
        WHERE debate_id = ? AND stage = 'debate' AND prompt LIKE ?
        ORDER BY id DESC LIMIT 1`,
    );

    const debates: ReplayedDebate[] = [];
    let emptyRows = 0;
    for (const row of rows) {
      const captured = promptFor.get(row.debate_id, `${MEDIATOR_PROMPT_PREFIX}%`) as
        | { prompt: string }
        | undefined;
      const replayed = replayDebate(
        row,
        captured === undefined ? null : parseCapturedViews(captured.prompt),
        weightsAt(adjustments, row.created_at),
      );
      if (replayed === null) emptyRows += 1;
      else debates.push(replayed);
    }
    return { debates, emptyRows };
  } finally {
    db.close();
  }
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const raw = argv[argv.indexOf('--db') + 1];
  if (!argv.includes('--db') || raw === undefined) {
    throw new Error('usage: replay-debate-conviction --db <path | file:<path>?mode=ro>');
  }
  const { debates, emptyRows } = loadAndReplay(resolveReadOnlyDbPath(raw));
  console.log(buildReport(debates, emptyRows, DEFAULT_TRADER_CONFIG.conviction_floor));
}
