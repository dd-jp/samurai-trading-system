import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalystView, Direction } from '../pipeline/debate-engine/index.js';
import { computeConvictionScore } from '../pipeline/debate-engine/index.js';
import {
  buildReport,
  type DebateRow,
  directionalConsensusCurrent,
  directionalConsensusPre683,
  loadAndReplay,
  parseCapturedViews,
  replayDebate,
  resolveReadOnlyDbPath,
  technicalConfidenceFromRationale,
  weightsAt,
} from './replay-debate-conviction.js';

const TECHNICAL_KEY_POINTS = [
  'Trend (5m): bullish',
  'Momentum (5m): bullish',
  'Structure (5m): bullish',
  'Axis votes: trend +1, momentum +1 — net 4 over 4 available axes, confidence 0.75',
];

function view(analyst_id: string, direction: Direction, confidence: number): AnalystView {
  return {
    trace_id: 'trace',
    analyst_id,
    analyst_type: analyst_id,
    direction,
    confidence,
    key_points:
      analyst_id === 'sentiment'
        ? ['NO DATA: no social items available for this window', 'Context: 20 candles']
        : analyst_id === 'technical'
          ? TECHNICAL_KEY_POINTS
          : ['12 news/filing items in window', 'Price reaction context: mark=1'],
    timestamp: new Date('2026-09-10T13:00:00.000Z'),
  };
}

function desk(fundamental: Direction): AnalystView[] {
  return [
    view('technical', 'bullish', 0.75),
    view('fundamental', fundamental, 0.2),
    view('sentiment', 'neutral', 0.05),
  ];
}

function mediatorPrompt(views: AnalystView[]): string {
  return [
    'You are the Mediator persona in a trading debate.',
    '<untrusted_analyst_data>',
    'Bull (bullish): {braces} in an argument must not confuse the parser',
    '</untrusted_analyst_data>',
    '',
    'Context:',
    '<untrusted_analyst_data>',
    JSON.stringify({ analyst_views: views }, null, 2),
    '</untrusted_analyst_data>',
  ].join('\n');
}

function row(views: AnalystView[], direction: Direction, confidence: number): DebateRow {
  return {
    debate_id: `debate-${direction}-${confidence}`,
    instrument: 'AAPL',
    bar_timestamp: '2026-09-10T13:00:00.000Z',
    direction,
    confidence,
    created_at: '2026-09-10T13:31:00.000Z',
    contributions_json: JSON.stringify(
      views.map((analystView) => ({
        analyst_id: analystView.analyst_id,
        analyst_type: analystView.analyst_type,
        stance_during_debate: [analystView.direction],
        final_position: analystView.direction,
        rationale: analystView.key_points.join('; '),
        influence_score: 0,
      })),
    ),
  };
}

describe('resolveReadOnlyDbPath', () => {
  it('turns the read-only file: URI into the path better-sqlite3 opens', () => {
    expect(resolveReadOnlyDbPath('file:/data/samurai-paper.sqlite?mode=ro')).toBe(
      '/data/samurai-paper.sqlite',
    );
    expect(resolveReadOnlyDbPath('/data/samurai-paper.sqlite')).toBe('/data/samurai-paper.sqlite');
  });

  it('refuses a URI asking for a writable mode', () => {
    expect(() => resolveReadOnlyDbPath('file:/data/x.sqlite?mode=rwc')).toThrow(/read-only/);
  });
});

describe('parseCapturedViews', () => {
  it('recovers the exact views from the context block of a captured mediator prompt', () => {
    const views = desk('bearish');
    expect(parseCapturedViews(mediatorPrompt(views))).toEqual(views);
  });

  it('returns null when the prompt carries no context block', () => {
    expect(parseCapturedViews('You are the Mediator persona')).toBeNull();
    expect(parseCapturedViews('x\nContext:\n{not json}')).toBeNull();
    expect(parseCapturedViews('x\nContext:\n{"analyst_views": []}')).toBeNull();
  });
});

describe('directional consensus', () => {
  it('lets the mediator lean a zero-net desk only before #683', () => {
    const split: Direction[] = ['bullish', 'bearish', 'neutral'];
    expect(directionalConsensusPre683(split, 'bullish')).toBe(0.25);
    expect(directionalConsensusCurrent(split, 'bullish')).toBe(0);
  });

  it('agrees across both eras on a desk that leans, and is symmetric in direction', () => {
    const bullish: Direction[] = ['bullish', 'bullish', 'neutral'];
    const bearish: Direction[] = ['bearish', 'bearish', 'neutral'];
    expect(directionalConsensusCurrent(bullish, 'bullish')).toBe(0.75);
    expect(directionalConsensusPre683(bullish, 'bullish')).toBe(0.75);
    expect(directionalConsensusCurrent(bearish, 'bearish')).toBe(0.75);
    expect(directionalConsensusCurrent(bullish, 'neutral')).toBe(0.5);
  });
});

describe('weightsAt', () => {
  const adjustments = [
    { analyst_id: 'technical', to_value: 1.05, created_at: '2026-09-15T00:00:00.081Z' },
    { analyst_id: 'technical', to_value: 1.1, created_at: '2026-09-16T00:00:00.142Z' },
  ];

  it('applies every adjustment made at or before the debate and none after', () => {
    expect(weightsAt(adjustments, '2026-09-14T23:59:59.000Z')).toEqual({});
    expect(weightsAt(adjustments, '2026-09-15T13:30:00.000Z')).toEqual({ technical: 1.05 });
    expect(weightsAt(adjustments, '2026-09-16T00:00:00.142Z')).toEqual({ technical: 1.1 });
  });
});

describe('technicalConfidenceFromRationale', () => {
  it('reads the post-cap confidence off the axis-vote key point', () => {
    const contributions = JSON.parse(row(desk('bearish'), 'bullish', 0.3).contributions_json);
    expect(technicalConfidenceFromRationale(contributions)).toBe(0.75);
    expect(technicalConfidenceFromRationale([])).toBeNull();
  });
});

describe('replayDebate', () => {
  it('skips a row whose debate never ran', () => {
    const empty = { ...row([], 'neutral', 0), contributions_json: '[]' };
    expect(replayDebate(empty, null, {})).toBeNull();
  });

  it('reproduces a persisted conviction exactly from captured views', () => {
    const views = desk('bullish');
    const persisted = computeConvictionScore(views, [], 'neutral');
    const replayed = replayDebate(row(views, 'neutral', persisted), views, {});

    expect(replayed?.match).toBe('current');
    expect(replayed?.replayedCurrent).toBe(persisted);
    expect(replayed?.desk).toBe('technical=bullish fundamental=bullish sentiment=neutral');
    expect(replayed?.technicalConfidence).toBe(0.75);
    expect(replayed?.fundamentalConfidence).toBe(0.2);
  });

  it('scores what the same desk would have carried had the mediator sided with it', () => {
    const views = desk('bullish');
    const replayed = replayDebate(
      row(views, 'neutral', computeConvictionScore(views, [], 'neutral')),
      views,
      {},
    );

    expect(replayed?.convictionIfMediatorSidedWithDesk).toBe(
      computeConvictionScore(views, [], 'bullish'),
    );
    expect(replayed?.convictionIfMediatorSidedWithDesk).toBeGreaterThan(0.55);
  });

  it('applies the analyst weights in force when the debate was written', () => {
    const views = desk('bullish');
    const unweighted = computeConvictionScore(views, [], 'bullish');
    const weights = { technical: 1.1, fundamental: 1.1 };
    const factor = 2.2 / 3.2 / (2 / 3);
    const replayed = replayDebate(row(views, 'bullish', unweighted * factor), views, weights);

    expect(replayed?.match).toBe('current');
    expect(replayDebate(row(views, 'bullish', unweighted * factor), views, {})?.match).toBe(
      'neither',
    );
  });

  it('names a captured row that only the pre-#683 consensus reproduces', () => {
    const views = desk('bearish');
    const evidence = (1 + (0.75 + 0.2) / 2) / 2;
    const replayed = replayDebate(row(views, 'bullish', 0.6 * 0.25 + 0.4 * evidence), views, {});

    expect(replayed?.match).toBe('pre-683-only');
    expect(replayed?.convictionIfMediatorSidedWithDesk).toBeNull();
  });

  it('backs the evidence term out of an uncaptured row and flags the era it needs', () => {
    const views = desk('bearish');
    const preEra = replayDebate(row(views, 'bullish', 0.15 + 0.4 * 0.8), null, {});
    expect(preEra?.captured).toBe(false);
    expect(preEra?.evidence).toBeCloseTo(0.8, 12);
    expect(preEra?.evidenceOnlyFeasiblePre683).toBe(true);
    expect(preEra?.technicalConfidence).toBe(0.75);

    const leaning = replayDebate(row(desk('bullish'), 'neutral', 0.3 + 0.4 * 0.7), null, {});
    expect(leaning?.evidence).toBeCloseTo(0.7, 12);
    expect(leaning?.evidenceOnlyFeasiblePre683).toBe(false);
    expect(leaning?.convictionIfMediatorSidedWithDesk).toBeCloseTo(0.45 + 0.4 * 0.7, 12);

    expect(replayDebate(row(views, 'bullish', 0.99), null, {})?.evidence).toBeNull();
  });
});

describe('loadAndReplay + buildReport', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function seed(): string {
    dir = mkdtempSync(join(tmpdir(), 'replay-debate-conviction-'));
    const dbPath = join(dir, 'paper.sqlite');
    const db = new BetterSqlite3(dbPath);
    db.exec(`
      CREATE TABLE debate_log (debate_id TEXT PRIMARY KEY, instrument TEXT, bar_timestamp TEXT,
        contributions_json TEXT, direction TEXT, confidence REAL, created_at TEXT);
      CREATE TABLE llm_call_log (id INTEGER PRIMARY KEY AUTOINCREMENT, stage TEXT,
        debate_id TEXT, prompt TEXT);
      CREATE TABLE dial_adjustments (id INTEGER PRIMARY KEY AUTOINCREMENT, dial_type TEXT,
        dial_name TEXT, to_value REAL, status TEXT, created_at TEXT);
    `);
    const insertDebate = db.prepare(
      `INSERT INTO debate_log VALUES (@debate_id, @instrument, @bar_timestamp,
         @contributions_json, @direction, @confidence, @created_at)`,
    );

    const aligned = desk('bullish');
    const alignedRow = row(aligned, 'neutral', computeConvictionScore(aligned, [], 'neutral'));
    insertDebate.run(alignedRow);
    db.prepare(`INSERT INTO llm_call_log (stage, debate_id, prompt) VALUES ('debate', ?, ?)`).run(
      alignedRow.debate_id,
      mediatorPrompt(aligned),
    );

    insertDebate.run({ ...row(desk('bearish'), 'bullish', 0.15 + 0.4 * 0.8), instrument: 'TSLA' });
    insertDebate.run({
      ...row([], 'neutral', 0),
      debate_id: 'never-ran',
      contributions_json: '[]',
    });
    db.close();
    return dbPath;
  }

  it('replays a store opened read-only and reports the desk-by-verdict picture', () => {
    const { debates, emptyRows } = loadAndReplay(seed());
    expect(emptyRows).toBe(1);
    expect(debates.map((debate) => debate.match).sort()).toEqual(['current', 'not-captured']);

    const report = buildReport(debates, emptyRows, 0.55);
    expect(report).toContain('debate_log rows: 3');
    expect(report).toContain('persisted == current: 1');
    expect(report).toContain('feasible only under pre-#683: 1');
    expect(report).toContain('bullish verdicts: 1; on a desk netting to zero: 1');
    expect(report).toContain('desks: 1; mediator verdict bullish: 0; neutral: 1');
    expect(report).toContain('>= 0.55: 1 of 1');
    expect(report).toContain('technical=bullish desks: 2; fundamental agrees on 1, opposes on 1');
    expect(report).toContain(
      'bars debating more than one instrument: 1; fundamental headline line identical across every instrument on 1',
    );
  });

  it('refuses to create a store that does not exist', () => {
    const missing = join(seed(), '..', 'absent.sqlite');
    expect(() => loadAndReplay(missing)).toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});
