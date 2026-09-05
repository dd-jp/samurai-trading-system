import { DEGRADED_DECISIONS, type PipelineLane } from '@contracts';
import { describe, expect, it } from 'vitest';
import { resolveLaneCells } from './lane-cells.ts';
import { at, makeLane } from './test-support.ts';

describe('resolveLaneCells', () => {
  it('carries the state word and tone already resolved against the lane outcome', () => {
    const idle = makeLane({ instrument: 'SPY', outcome: 'idle' });
    for (const cell of resolveLaneCells(idle)) {
      expect(cell.present).toBe(true);
      expect(cell.word).toBe('idle');
      expect(cell.tone).toBe('wait');
    }

    const inFlight = makeLane({
      instrument: 'BTC-USD',
      outcome: 'in_flight',
      cells: { analysts: { state: 'done' } },
    });
    const debate = resolveLaneCells(inFlight).find((cell) => cell.stage === 'debate');
    expect(debate).toMatchObject({ word: 'wait', tone: 'wait' });
  });

  it('glosses every DEGRADED_DECISIONS word and sets `degraded`, leaving a real decision word alone', () => {
    for (const [word, gloss] of Object.entries(DEGRADED_DECISIONS)) {
      const lane = makeLane({
        instrument: 'QQQ',
        outcome: 'stopped',
        cells: { debate: { state: 'done', decision: word } },
      });
      const cell = resolveLaneCells(lane).find((c) => c.stage === 'debate');
      expect(cell?.degraded).toBe(true);
      expect(cell?.decision).toBe(`${word} — ${gloss}`);
      expect(cell?.decisionText).toBe(cell?.decision);
    }

    const genuine = makeLane({
      instrument: 'QQQ',
      outcome: 'stopped',
      cells: { trader: { state: 'stopped', decision: 'no_trade' } },
    });
    const traderCell = resolveLaneCells(genuine).find((c) => c.stage === 'trader');
    expect(traderCell?.degraded).toBe(false);
    expect(traderCell?.decision).toBe('no_trade');
    expect(traderCell?.decisionText).toBe('no_trade');
  });

  it('treats an empty-string decision the same as no decision recorded', () => {
    const lane = makeLane({
      instrument: 'QQQ',
      outcome: 'stopped',
      cells: { trader: { state: 'stopped', decision: '' } },
    });
    const cell = resolveLaneCells(lane).find((c) => c.stage === 'trader');
    expect(cell?.decision).toBeNull();
    expect(cell?.degraded).toBe(false);
  });

  it('names why there is no decision, per cell state and stage, for the drawer’s prose', () => {
    const lane = makeLane({
      instrument: 'QQQ',
      outcome: 'in_flight',
      cells: {
        analysts: { state: 'done', decision: 'quorum_met' },
        debate: { state: 'live' },
        trader: { state: 'skipped' },
        risk: { state: 'stopped' },
      },
    });
    const byStage = new Map(resolveLaneCells(lane).map((c) => [c.stage, c]));
    expect(byStage.get('debate')?.decisionText).toBe('in progress');
    expect(byStage.get('trader')?.decisionText).toBe('skipped — the tick continued');
    // `trader` never records a decision word (#328), regardless of state.
    expect(byStage.get('risk')?.decisionText).toBe('no decision word recorded (#328)');
    expect(byStage.get('verdict')?.decisionText).toBe('not reached');
  });

  it('says "no decision recorded" for a stage outside #328 that recorded none', () => {
    const lane = makeLane({
      instrument: 'QQQ',
      outcome: 'stopped',
      cells: { execution: { state: 'done' } },
    });
    const cell = resolveLaneCells(lane).find((c) => c.stage === 'execution');
    expect(cell?.decisionText).toBe('no decision recorded');
  });

  it('marks a stage absent from the wire as `present: false`, not a fabricated state', () => {
    const noCellsLane: PipelineLane = {
      instrument: 'QQQ',
      asset_class: 'stocks',
      trace_id: 'trace-qqq',
      cells: [
        {
          stage: 'analysts',
          state: 'done',
          duration_ms: 1_000,
          decision: 'quorum_met',
          recorded_at: at(0),
          attempts: 1,
        },
      ],
      outcome: 'in_flight',
      final_stage: 'analysts',
      started_at: at(0),
      total_ms: null,
    };
    const resolved = resolveLaneCells(noCellsLane);
    expect(resolved.find((c) => c.stage === 'analysts')?.present).toBe(true);
    const debate = resolved.find((c) => c.stage === 'debate');
    expect(debate).toMatchObject({
      present: false,
      word: 'no cell',
      tone: 'wait',
      decision: null,
      degraded: false,
      attempts: 0,
      recordedAt: null,
      durationMs: null,
    });
  });

  it('carries attempts, recordedAt and durationMs through from the wire cell', () => {
    const lane = makeLane({
      instrument: 'QQQ',
      outcome: 'stopped',
      cells: {
        risk: {
          state: 'stopped',
          decision: 'rejected',
          attempts: 3,
          recorded_at: at(5_000),
          duration_ms: 2_600,
        },
      },
    });
    const cell = resolveLaneCells(lane).find((c) => c.stage === 'risk');
    expect(cell).toMatchObject({ attempts: 3, recordedAt: at(5_000), durationMs: 2_600 });
  });
});
