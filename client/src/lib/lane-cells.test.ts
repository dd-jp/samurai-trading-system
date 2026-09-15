import { DEGRADED_DECISIONS, type DebateRow, type PipelineLane } from '@contracts';
import { describe, expect, it } from 'vitest';
import { debateDegradedGloss } from './debate-termination.ts';
import { resolveLaneCells } from './lane-cells.ts';
import { at, makeLane } from './test-support.ts';

describe('resolveLaneCells', () => {
  it('carries the state word and tone paired, already resolved against the lane outcome', () => {
    const idle = makeLane({ instrument: 'SPY', outcome: 'idle' });
    for (const cell of resolveLaneCells(idle, undefined)) {
      expect(cell.present).toBe(true);
      expect(cell.state).toEqual({ word: 'idle', tone: 'wait' });
    }

    const inFlight = makeLane({
      instrument: 'BTC-USD',
      outcome: 'in_flight',
      cells: { analysts: { state: 'done' } },
    });
    const debate = resolveLaneCells(inFlight, undefined).find((cell) => cell.stage === 'debate');
    expect(debate?.state).toEqual({ word: 'wait', tone: 'wait' });
  });

  it('glosses every DEGRADED_DECISIONS word into `decisionText`, keeps `decisionWord` bare, and sets `degraded`', () => {
    for (const [word, gloss] of Object.entries(DEGRADED_DECISIONS)) {
      const lane = makeLane({
        instrument: 'QQQ',
        outcome: 'stopped',
        cells: { debate: { state: 'done', decision: word } },
      });
      const cell = resolveLaneCells(lane, undefined).find((c) => c.stage === 'debate');
      expect(cell?.degraded).toBe(true);
      expect(cell?.hasRecordedDecision).toBe(true);
      // The matrix paints this — dashboard-spec.md:135 gives a cell its
      // decision WORD, not a sentence — so it must stay the bare word even
      // when degraded
      expect(cell?.decisionWord).toBe(word);
      expect(cell?.decisionText).toBe(`${word} — ${gloss}`);
    }

    const genuine = makeLane({
      instrument: 'QQQ',
      outcome: 'stopped',
      cells: { trader: { state: 'stopped', decision: 'no_trade' } },
    });
    const traderCell = resolveLaneCells(genuine, undefined).find((c) => c.stage === 'trader');
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
    const cell = resolveLaneCells(lane, undefined).find((c) => c.stage === 'trader');
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
    const byStage = new Map(resolveLaneCells(lane, undefined).map((c) => [c.stage, c]));
    expect(byStage.get('debate')?.decisionText).toBe('in progress');
    expect(byStage.get('trader')?.decisionText).toBe('skipped — the tick continued');
    // `risk` never records a decision word (#328), regardless of state
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
    const cell = resolveLaneCells(lane, undefined).find((c) => c.stage === 'execution');
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
    const resolved = resolveLaneCells(noCellsLane, undefined);
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
    const cell = resolveLaneCells(lane, undefined).find((c) => c.stage === 'risk');
    expect(cell).toMatchObject({ attempts: 3, recordedAt: at(5_000), durationMs: 2_600 });
  });
});

describe('resolveLaneCells against the debate row (#1428)', () => {
  const truncatedByLlmFailure: Pick<DebateRow, 'termination' | 'termination_cause'> = {
    termination: 'latency_truncated',
    termination_cause: 'llm_failure',
  };

  function debateCellOf(
    decision: string,
    debate: Pick<DebateRow, 'termination' | 'termination_cause'> | undefined,
  ) {
    const lane = makeLane({
      instrument: 'QQQ',
      outcome: 'stopped',
      cells: { debate: { state: 'done', decision } },
    });
    return resolveLaneCells(lane, debate).find((c) => c.stage === 'debate');
  }

  it('names WHICH control fired, from the same gloss the rail and the debate section use', () => {
    const gloss = debateDegradedGloss(truncatedByLlmFailure);
    expect(gloss).not.toBeNull();

    const cell = debateCellOf('budget_exhausted', truncatedByLlmFailure);
    // Derived from the shared function, not a literal, so a reworded gloss
    // propagates here instead of the two drifting apart again (#1080's class)
    expect(cell?.decisionText.endsWith(gloss as string)).toBe(true);
    // The defect: `audit_log`'s word cannot tell a fired budget from an
    // escaped LLM failure, so stopping at it puts this cell in silent
    // disagreement with `DebateSection` in the same drawer
    expect(cell?.decisionText).not.toBe(
      `budget_exhausted — ${DEGRADED_DECISIONS.budget_exhausted}`,
    );
    // dashboard-spec.md:135 — the matrix still paints the bare audit word
    expect(cell?.decisionWord).toBe('budget_exhausted');
    expect(cell?.degraded).toBe(true);
  });

  it('reconciles the mid-debate truncation word too, not only the starved one', () => {
    const cell = debateCellOf('timed_out_partial', truncatedByLlmFailure);
    expect(cell?.decisionText.endsWith(debateDegradedGloss(truncatedByLlmFailure) as string)).toBe(
      true,
    );
  });

  it('leaves a degraded word that is not a latency truncation glossed by `audit_log` alone', () => {
    // `not_admitted` comes from `debateDecisionWord`'s rate-limit arm, which
    // never sets `timed_out` and so never writes a `termination_cause`. The
    // lane joins its debate by INSTRUMENT, so the row reachable here can be a
    // DIFFERENT, truncated debate — glossing it on would claim an LLM failure
    // for a debate that was never admitted
    const cell = debateCellOf('not_admitted', truncatedByLlmFailure);
    expect(cell?.decisionText).toBe(`not_admitted — ${DEGRADED_DECISIONS.not_admitted}`);
  });

  it('leaves a non-debate stage untouched by the debate row', () => {
    const lane = makeLane({
      instrument: 'QQQ',
      outcome: 'stopped',
      cells: { analysts: { state: 'stopped', decision: 'quorum_skip_timeout' } },
    });
    const cell = resolveLaneCells(lane, truncatedByLlmFailure).find((c) => c.stage === 'analysts');
    expect(cell?.decisionText).toBe(
      `quorum_skip_timeout — ${DEGRADED_DECISIONS.quorum_skip_timeout}`,
    );
  });

  it('falls back to `audit_log`’s own gloss when no debate row reached the client', () => {
    const cell = debateCellOf('budget_exhausted', undefined);
    expect(cell?.decisionText).toBe(`budget_exhausted — ${DEGRADED_DECISIONS.budget_exhausted}`);
  });

  it('carries the indeterminate gloss for a row written before migration 0051', () => {
    const preMigration: Pick<DebateRow, 'termination' | 'termination_cause'> = {
      termination: 'latency_truncated',
    };
    const cell = debateCellOf('budget_exhausted', preMigration);
    // `debateDegradedGloss` says the cause is unrecorded rather than naming
    // one, and that is what an operator needs here too
    expect(cell?.decisionText.endsWith(debateDegradedGloss(preMigration) as string)).toBe(true);
  });

  it('ignores a converged debate row — nothing to reconcile', () => {
    const cell = debateCellOf('budget_exhausted', { termination: 'converged' });
    expect(cell?.decisionText).toBe(`budget_exhausted — ${DEGRADED_DECISIONS.budget_exhausted}`);
  });
});
