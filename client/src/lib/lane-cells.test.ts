import { DEGRADED_DECISIONS, type PipelineLane } from '@contracts';
import { describe, expect, it } from 'vitest';
import { resolveLaneCells } from './lane-cells.ts';
import { at, makeLane } from './test-support.ts';

describe('resolveLaneCells', () => {
  it('carries the state word and tone paired, already resolved against the lane outcome', () => {
    const idle = makeLane({ instrument: 'SPY', outcome: 'idle' });
    for (const cell of resolveLaneCells(idle)) {
      expect(cell.present).toBe(true);
      expect(cell.state).toEqual({ word: 'idle', tone: 'wait' });
    }

    const inFlight = makeLane({
      instrument: 'BTC-USD',
      outcome: 'in_flight',
      cells: { analysts: { state: 'done' } },
    });
    const debate = resolveLaneCells(inFlight).find((cell) => cell.stage === 'debate');
    expect(debate?.state).toEqual({ word: 'wait', tone: 'wait' });
  });

  it('glosses every DEGRADED_DECISIONS word into `decisionText`, keeps `decisionWord` bare, and sets `degraded`', () => {
    for (const [word, gloss] of Object.entries(DEGRADED_DECISIONS)) {
      const lane = makeLane({
        instrument: 'QQQ',
        outcome: 'stopped',
        cells: { debate: { state: 'done', decision: word } },
      });
      const cell = resolveLaneCells(lane).find((c) => c.stage === 'debate');
      expect(cell?.degraded).toBe(true);
      expect(cell?.hasRecordedDecision).toBe(true);
      // The matrix paints this — dashboard-spec.md:135 gives a cell its
      // decision WORD, not a sentence — so it must stay the bare word even
      // when degraded.
      expect(cell?.decisionWord).toBe(word);
      expect(cell?.decisionText).toBe(`${word} — ${gloss}`);
    }

    const genuine = makeLane({
      instrument: 'QQQ',
      outcome: 'stopped',
      cells: { trader: { state: 'stopped', decision: 'no_trade' } },
    });
    const traderCell = resolveLaneCells(genuine).find((c) => c.stage === 'trader');
    expect(traderCell?.degraded).toBe(false);
    expect(traderCell?.hasRecordedDecision).toBe(true);
    expect(traderCell?.decisionWord).toBe('no_trade');
    expect(traderCell?.decisionText).toBe('no_trade');
  });

  it('treats an empty-string decision the same as no decision recorded', () => {
    const lane = makeLane({
      instrument: 'QQQ',
      outcome: 'stopped',
      cells: { trader: { state: 'stopped', decision: '' } },
    });
    const cell = resolveLaneCells(lane).find((c) => c.stage === 'trader');
    expect(cell?.hasRecordedDecision).toBe(false);
    expect(cell?.decisionWord).toBeNull();
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
    // `risk` never records a decision word (#328), regardless of state.
    expect(byStage.get('risk')?.decisionText).toBe('no decision word recorded (#328)');
    expect(byStage.get('verdict')?.decisionText).toBe('not reached');
    for (const stage of ['debate', 'trader', 'risk', 'verdict'] as const) {
      expect(byStage.get(stage)?.hasRecordedDecision).toBe(false);
      expect(byStage.get(stage)?.decisionWord).toBeNull();
    }
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
      state: { word: 'no cell', tone: 'wait' },
      hasRecordedDecision: false,
      decisionWord: null,
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
