import { describe, expect, it } from 'vitest';
import {
  makeClosedTrade,
  makeDebate,
  makeFill,
  makePosition,
  makeRiskCritic,
  makeSnapshot,
  makeVerdict,
} from '../test-fixtures.ts';
import { laneDebate, resolveTrace, resolveTrade } from './resolve-trace.ts';
import { doneThrough, makeLane, makeView } from './test-support.ts';

describe('resolveTrade', () => {
  it('recovers the trace from the critic row keyed to the trade’s debate', () => {
    const lane = doneThrough('SPY', 'trace-spy', 'execution', { outcome: 'go' });
    const detail = resolveTrade(
      makeSnapshot({
        pipeline: makeView([lane]),
        closed_trades: [makeClosedTrade({ idempotency_key: 'k1', debate_id: 'd1' })],
        debates: [
          makeDebate({ debate_id: 'decoy', instrument: 'SPY' }),
          makeDebate({ debate_id: 'd1', instrument: 'SPY' }),
        ],
        risk_critics: [
          makeRiskCritic({ debate_id: 'other', trace_id: 'trace-other', instrument: 'SPY' }),
          makeRiskCritic({ debate_id: 'd1', trace_id: 'trace-spy', instrument: 'SPY' }),
        ],
        verdicts: [makeVerdict({ trace_id: 'trace-spy', instrument: 'SPY', status: 'go' })],
        fills: [
          makeFill({ idempotency_key: 'k1', broker_fill_id: 'f-mine' }),
          makeFill({ idempotency_key: 'k2', broker_fill_id: 'f-other' }),
        ],
      }),
      'k1',
    );
    expect(detail?.debate?.debate_id).toBe('d1');
    expect(detail?.debateJoin).toEqual({ by: 'debate_id', exact: true });
    expect(detail?.riskCritic?.trace_id).toBe('trace-spy');
    expect(detail?.riskCriticJoin).toEqual({ by: 'debate_id', exact: true });
    expect(detail?.traceId).toBe('trace-spy');
    expect(detail?.verdict?.status).toBe('go');
    expect(detail?.lane?.trace_id).toBe('trace-spy');
    expect(detail?.cells?.map((cell) => cell.stage)).toContain('execution');
    expect(detail?.absence.trace).toBeNull();
    expect(detail?.fills.map((fill) => fill.broker_fill_id)).toEqual(['f-mine']);
  });

  it('reaches no trace at all when no critic row names the trade’s debate', () => {
    const detail = resolveTrade(
      makeSnapshot({
        pipeline: makeView([doneThrough('SPY', 'trace-spy', 'execution', { outcome: 'go' })]),
        closed_trades: [makeClosedTrade({ idempotency_key: 'k1', debate_id: 'd1' })],
        risk_critics: [makeRiskCritic({ debate_id: 'other', instrument: 'SPY' })],
        debates: [],
      }),
      'k1',
    );
    expect(detail?.riskCritic).toBeUndefined();
    expect(detail?.traceId).toBeNull();
    expect(detail?.verdict).toBeUndefined();
    expect(detail?.cells).toBeNull();
    expect(detail?.absence.trace).toBe('unreachable');
  });

  it('names an aged-out trace apart from an unreachable one', () => {
    const detail = resolveTrade(
      makeSnapshot({
        pipeline: makeView([]),
        closed_trades: [makeClosedTrade({ idempotency_key: 'k1', debate_id: 'd1' })],
        risk_critics: [
          makeRiskCritic({ debate_id: 'd1', trace_id: 'trace-gone', instrument: 'SPY' }),
        ],
      }),
      'k1',
    );
    expect(detail?.traceId).toBe('trace-gone');
    expect(detail?.cells).toBeNull();
    expect(detail?.absence.trace).toBe('aged_out');
  });

  it('is null for a key no longer in the recent-history window', () => {
    expect(resolveTrade(makeSnapshot({ closed_trades: [] }), 'k1')).toBeNull();
  });
});

describe('resolveTrace', () => {
  it('joins the lane, verdict, critic row, position and fills of a settled trace', () => {
    const detail = resolveTrace(
      makeSnapshot({
        pipeline: makeView([doneThrough('SPY', 'trace-spy', 'execution', { outcome: 'go' })]),
        verdicts: [makeVerdict({ trace_id: 'trace-spy', instrument: 'SPY' })],
        risk_critics: [makeRiskCritic({ trace_id: 'trace-spy', instrument: 'SPY' })],
        positions: [makePosition({ instrument: 'SPY', idempotency_key: 'k1' })],
        fills: [
          makeFill({ idempotency_key: 'k1', broker_fill_id: 'f-mine' }),
          makeFill({ idempotency_key: 'k9', broker_fill_id: 'f-other' }),
        ],
      }),
      { instrument: 'SPY', traceId: null },
    );
    expect(detail.traceId).toBe('trace-spy');
    expect(detail.verdict?.trace_id).toBe('trace-spy');
    expect(detail.riskCritic?.trace_id).toBe('trace-spy');
    expect(detail.riskCriticJoin).toEqual({ by: 'trace_id', exact: true });
    expect(detail.settled).toBe('go');
    expect(detail.cells).not.toBeNull();
    expect(detail.absence.lane).toBeNull();
    expect(detail.fills.map((fill) => fill.broker_fill_id)).toEqual(['f-mine']);
  });

  it('takes the instrument’s newest debate and says the join is not exact', () => {
    const detail = resolveTrace(
      makeSnapshot({
        pipeline: makeView([doneThrough('SPY', 'trace-spy', 'execution', { outcome: 'go' })]),
        debates: [
          makeDebate({ debate_id: 'qqq-newest', instrument: 'QQQ' }),
          makeDebate({ debate_id: 'spy-newest', instrument: 'SPY' }),
          makeDebate({ debate_id: 'spy-older', instrument: 'SPY' }),
        ],
        risk_critics: [
          makeRiskCritic({ trace_id: 'trace-spy', instrument: 'SPY', debate_id: 'spy-older' }),
        ],
      }),
      { instrument: 'SPY', traceId: null },
    );
    expect(detail.debate?.debate_id).toBe('spy-newest');
    expect(detail.debateJoin).toEqual({ by: 'instrument', exact: false });
  });

  it('never attributes the live arm’s debate to a control-arm lane on the same instrument', () => {
    const detail = resolveTrace(
      makeSnapshot({
        arm: 'control',
        pipeline: makeView([doneThrough('SPY', 'trace-spy', 'execution', { outcome: 'go' })]),
        debates: [makeDebate({ debate_id: 'spy-newest', instrument: 'SPY' })],
      }),
      { instrument: 'SPY', traceId: null },
    );
    expect(detail.debate).toBeUndefined();
  });

  it('finds no debate for an instrument with none in the window', () => {
    const detail = resolveTrace(
      makeSnapshot({
        pipeline: makeView([doneThrough('SPY', 'trace-spy', 'risk', { outcome: 'stopped' })]),
        debates: [makeDebate({ instrument: 'QQQ' })],
      }),
      { instrument: 'SPY', traceId: null },
    );
    expect(detail.debate).toBeUndefined();
    expect(detail.inFlight).toBe(false);
  });

  it('reports an in-flight lane, which has no settled outcome', () => {
    const detail = resolveTrace(
      makeSnapshot({
        pipeline: makeView([doneThrough('SPY', 'trace-spy', 'debate', { outcome: 'in_flight' })]),
      }),
      { instrument: 'SPY', traceId: null },
    );
    expect(detail.inFlight).toBe(true);
    expect(detail.settled).toBeNull();
    expect(detail.cells).not.toBeNull();
  });

  it('matches a critic row on BOTH trace and instrument, never one alone (#1066)', () => {
    const snapshot = makeSnapshot({
      pipeline: makeView([
        doneThrough('SPY', 'trace-1', 'risk', { outcome: 'stopped' }),
        doneThrough('QQQ', 'trace-1-qqq', 'risk', { outcome: 'stopped' }),
      ]),
      risk_critics: [
        makeRiskCritic({ trace_id: 'trace-0', instrument: 'SPY', reasoning: 'older trace' }),
        makeRiskCritic({ trace_id: 'trace-1', instrument: 'QQQ', reasoning: 'wrong row' }),
        makeRiskCritic({ trace_id: 'trace-1', instrument: 'SPY', reasoning: 'right row' }),
      ],
    });
    expect(
      resolveTrace(snapshot, { instrument: 'SPY', traceId: 'trace-1' })?.riskCritic?.reasoning,
    ).toBe('right row');
    expect(
      resolveTrace(snapshot, { instrument: 'AAPL', traceId: 'trace-1' }).riskCritic,
    ).toBeUndefined();
  });

  it('never resolves another instrument’s lane for a mismatched selection (#1205)', () => {
    const snapshot = makeSnapshot({
      pipeline: makeView([doneThrough('SPY', 'trace-1', 'execution', { outcome: 'go' })]),
      verdicts: [makeVerdict({ trace_id: 'trace-1', instrument: 'SPY' })],
    });
    const detail = resolveTrace(snapshot, { instrument: 'AAPL', traceId: 'trace-1' });
    expect(detail.lane).toBeUndefined();
    expect(detail.cells).toBeNull();
    expect(detail.verdict).toBeUndefined();
    expect(detail.absence.lane).toBe('wrong_instrument');
    expect(detail.traceId).toBeNull();
  });

  it('names a mismatch by its verdict alone, when the lane has already left the window (#1267)', () => {
    const snapshot = makeSnapshot({
      pipeline: makeView([doneThrough('SPY', 'trace-2', 'execution', { outcome: 'go' })]),
      verdicts: [makeVerdict({ trace_id: 'trace-1', instrument: 'SPY' })],
    });
    const detail = resolveTrace(snapshot, { instrument: 'AAPL', traceId: 'trace-1' });
    expect(detail.absence.lane).toBe('wrong_instrument');
    expect(detail.traceId).toBeNull();
  });

  it('names a mismatch by its risk-critic row alone, with no lane or verdict attesting it', () => {
    const snapshot = makeSnapshot({
      pipeline: makeView([]),
      risk_critics: [makeRiskCritic({ trace_id: 'trace-1', instrument: 'SPY' })],
    });
    const detail = resolveTrace(snapshot, { instrument: 'AAPL', traceId: 'trace-1' });
    expect(detail.absence.lane).toBe('wrong_instrument');
    expect(detail.traceId).toBeNull();
  });

  it('names a mismatch by its lane alone, with no verdict, risk-critic or tick_status attesting it', () => {
    const snapshot = makeSnapshot({
      pipeline: makeView([doneThrough('SPY', 'trace-1', 'trader')]),
      verdicts: [],
      risk_critics: [],
    });
    const detail = resolveTrace(snapshot, { instrument: 'AAPL', traceId: 'trace-1' });
    expect(detail.absence.lane).toBe('wrong_instrument');
    expect(detail.traceId).toBeNull();
  });

  it('keeps a same-instrument verdict as aged-out, not a wrong-instrument mismatch', () => {
    const snapshot = makeSnapshot({
      pipeline: makeView([]),
      verdicts: [makeVerdict({ trace_id: 'trace-gone', instrument: 'SPY' })],
    });
    const detail = resolveTrace(snapshot, { instrument: 'SPY', traceId: 'trace-gone' });
    expect(detail.absence.lane).toBe('aged_out');
    expect(detail.traceId).toBe('trace-gone');
  });

  it('keeps a same-instrument risk-critic row as aged-out, not a wrong-instrument mismatch', () => {
    const snapshot = makeSnapshot({
      pipeline: makeView([]),
      risk_critics: [makeRiskCritic({ trace_id: 'trace-gone', instrument: 'SPY' })],
    });
    const detail = resolveTrace(snapshot, { instrument: 'SPY', traceId: 'trace-gone' });
    expect(detail.absence.lane).toBe('aged_out');
    expect(detail.traceId).toBe('trace-gone');
  });

  it('names a mismatch by tick_status alone, when no lane, verdict or risk-critic row attests it (#1267)', () => {
    const snapshot = makeSnapshot({
      pipeline: makeView([]),
      tick_status: {
        instrument: 'SPY',
        asset_class: 'stocks',
        stage: 'analysts',
        trace_id: 'trace-1',
      },
    });
    const detail = resolveTrace(snapshot, { instrument: 'AAPL', traceId: 'trace-1' });
    expect(detail.absence.lane).toBe('wrong_instrument');
    expect(detail.traceId).toBeNull();
  });

  it('keeps a same-instrument tick_status as aged-out, not a wrong-instrument mismatch', () => {
    const snapshot = makeSnapshot({
      pipeline: makeView([]),
      tick_status: {
        instrument: 'SPY',
        asset_class: 'stocks',
        stage: 'analysts',
        trace_id: 'trace-gone',
      },
    });
    const detail = resolveTrace(snapshot, { instrument: 'SPY', traceId: 'trace-gone' });
    expect(detail.absence.lane).toBe('aged_out');
    expect(detail.traceId).toBe('trace-gone');
  });

  it('says an idle lane is idle rather than absent, and joins it to no critic row', () => {
    const detail = resolveTrace(
      makeSnapshot({
        pipeline: makeView([makeLane({ instrument: 'SPY', outcome: 'idle' })]),
        risk_critics: [makeRiskCritic({ trace_id: 'trace-spy', instrument: 'SPY' })],
      }),
      { instrument: 'SPY', traceId: null },
    );
    expect(detail.traceId).toBeNull();
    expect(detail.cells).toBeNull();
    expect(detail.absence.lane).toBe('idle');
    expect(detail.riskCritic).toBeUndefined();
  });

  it('separates a trace that aged out of the window from an instrument with no lane', () => {
    const snapshot = makeSnapshot({ pipeline: makeView([]) });
    expect(resolveTrace(snapshot, { instrument: 'SPY', traceId: 'trace-gone' }).absence.lane).toBe(
      'aged_out',
    );
    expect(resolveTrace(snapshot, { instrument: 'SPY', traceId: null }).absence.lane).toBe('none');
  });

  it('pins the trace the selection names, not the instrument’s current lane', () => {
    const detail = resolveTrace(
      makeSnapshot({
        pipeline: makeView([
          doneThrough('SPY', 'trace-new', 'execution', { outcome: 'go' }),
          doneThrough('SPY', 'trace-old', 'verdict', { outcome: 'no_go' }),
        ]),
      }),
      { instrument: 'SPY', traceId: 'trace-old' },
    );
    expect(detail.lane?.trace_id).toBe('trace-old');
    expect(detail.settled).toBe('no_go');
  });

  it('finds no fills when the instrument has no open position', () => {
    const detail = resolveTrace(
      makeSnapshot({
        pipeline: makeView([doneThrough('SPY', 'trace-spy', 'execution', { outcome: 'go' })]),
        positions: [],
        fills: [makeFill({ idempotency_key: 'k1' })],
      }),
      { instrument: 'SPY', traceId: null },
    );
    expect(detail.position).toBeUndefined();
    expect(detail.fills).toEqual([]);
  });
});

describe('laneDebate', () => {
  it('hands the lane matrix the SAME row the drawer resolves for that instrument (#1428)', () => {
    const lane = doneThrough('SPY', 'trace-spy', 'execution', { outcome: 'go' });
    const snapshot = makeSnapshot({
      pipeline: makeView([lane]),
      debates: [
        makeDebate({ debate_id: 'newest-spy', instrument: 'SPY' }),
        makeDebate({ debate_id: 'older-spy', instrument: 'SPY' }),
        makeDebate({ debate_id: 'other', instrument: 'QQQ' }),
      ],
    });
    expect(laneDebate(snapshot, lane)).toBe(
      resolveTrace(snapshot, { instrument: 'SPY', traceId: null }).debate,
    );
    expect(laneDebate(snapshot, lane)?.debate_id).toBe('newest-spy');
  });

  it('has no row for an instrument whose debates have left the window', () => {
    const lane = doneThrough('SPY', 'trace-spy', 'execution', { outcome: 'go' });
    const snapshot = makeSnapshot({
      pipeline: makeView([lane]),
      debates: [makeDebate({ instrument: 'QQQ' })],
    });
    expect(laneDebate(snapshot, lane)).toBeUndefined();
  });

  it('agrees with resolveTrace’s undefined on a control-arm snapshot, same instrument', () => {
    const lane = doneThrough('SPY', 'trace-spy', 'execution', { outcome: 'go' });
    const snapshot = makeSnapshot({
      arm: 'control',
      pipeline: makeView([lane]),
      debates: [makeDebate({ debate_id: 'spy-newest', instrument: 'SPY' })],
    });
    expect(laneDebate(snapshot, lane)).toBeUndefined();
    expect(laneDebate(snapshot, lane)).toBe(
      resolveTrace(snapshot, { instrument: 'SPY', traceId: null }).debate,
    );
  });
});
