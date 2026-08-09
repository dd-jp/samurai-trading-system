import { JsonDebateLogger, type LogSink } from './debate-logger.js';
import type { AnalystView, DebateResult } from './types.js';

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'analyst-technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.82,
    key_points: ['RSI oversold bounce'],
    timestamp: new Date('2026-07-14T09:00:00Z'),
    ...overrides,
  };
}

function makeResult(overrides: Partial<DebateResult> = {}): DebateResult {
  return {
    synthesis: 'Bulls have the stronger case this bar.',
    position: 'Buy',
    confidence: 0.7,
    contributions: [],
    disagreement_summary: 'Bear cites overextension; bull cites volume confirmation.',
    open_items: [],
    converged: true,
    rounds_completed: 2,
    latency_ms: 8000,
    direction: 'bullish',
    debate_id: 'debate-1',
    ...overrides,
  };
}

function makeSink(): { sink: LogSink; log: ReturnType<typeof vi.fn> } {
  const log = vi.fn();
  return { sink: { log }, log };
}

describe('JsonDebateLogger', () => {
  it('logInputs captures analyst views and failures', () => {
    const { sink, log } = makeSink();
    const logger = new JsonDebateLogger(sink);
    const views = [makeView()];
    const failures = [
      { analyst_id: 'analyst-sentiment-1', analyst_type: 'sentiment', reason: 'timeout' },
    ];

    logger.logInputs({ trace_id: 'trace-1', debate_id: 'debate-1', views, failures });

    expect(log).toHaveBeenCalledWith({
      trace_id: 'trace-1',
      stage: 'debate',
      level: 'info',
      message: 'debate.inputs',
      payload: { debate_id: 'debate-1', views, failures },
    });
  });

  it('logRound captures the persona, statement, round number, and timestamp', () => {
    const { sink, log } = makeSink();
    const logger = new JsonDebateLogger(sink);
    const timestamp = new Date('2026-07-14T09:00:05Z');

    logger.logRound({
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      round: 1,
      persona: 'bull',
      statement: 'Volume confirms the breakout.',
      timestamp,
    });

    expect(log).toHaveBeenCalledWith({
      trace_id: 'trace-1',
      stage: 'debate',
      level: 'info',
      message: 'debate.round',
      payload: {
        debate_id: 'debate-1',
        round: 1,
        persona: 'bull',
        statement: 'Volume confirms the breakout.',
        timestamp,
      },
    });
  });

  it('logOutput captures the full DebateResult', () => {
    const { sink, log } = makeSink();
    const logger = new JsonDebateLogger(sink);
    const result = makeResult();

    logger.logOutput({ trace_id: 'trace-1', debate_id: 'debate-1', result });

    expect(log).toHaveBeenCalledWith({
      trace_id: 'trace-1',
      stage: 'debate',
      level: 'info',
      message: 'debate.output',
      payload: { debate_id: 'debate-1', result },
    });
  });

  it('logLatency reports info when within budget', () => {
    const { sink, log } = makeSink();
    const logger = new JsonDebateLogger(sink);

    logger.logLatency({
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      latency_ms: 9000,
      budget_ms: 15000,
    });

    expect(log).toHaveBeenCalledWith({
      trace_id: 'trace-1',
      stage: 'debate',
      level: 'info',
      message: 'debate.latency',
      payload: { debate_id: 'debate-1', latency_ms: 9000, budget_ms: 15000 },
    });
  });

  it('logLatency reports warn when the actual time exceeds budget', () => {
    const { sink, log } = makeSink();
    const logger = new JsonDebateLogger(sink);

    logger.logLatency({
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      latency_ms: 16000,
      budget_ms: 15000,
    });

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', message: 'debate.latency' }),
    );
  });

  it('logTimeout captures the elapsed time, budget, and reason', () => {
    const { sink, log } = makeSink();
    const logger = new JsonDebateLogger(sink);

    logger.logTimeout({
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      elapsed_ms: 15200,
      budget_ms: 15000,
      reason: 'latency budget exceeded before mediator convergence',
    });

    expect(log).toHaveBeenCalledWith({
      trace_id: 'trace-1',
      stage: 'debate',
      level: 'warn',
      message: 'debate.timeout',
      payload: {
        debate_id: 'debate-1',
        elapsed_ms: 15200,
        budget_ms: 15000,
        reason: 'latency budget exceeded before mediator convergence',
      },
    });
  });

  it('logAnalystFailure captures the analyst id, type, and reason', () => {
    const { sink, log } = makeSink();
    const logger = new JsonDebateLogger(sink);

    logger.logAnalystFailure({
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      failure: {
        analyst_id: 'analyst-sentiment-1',
        analyst_type: 'sentiment',
        reason: 'malformed output: missing confidence',
      },
    });

    expect(log).toHaveBeenCalledWith({
      trace_id: 'trace-1',
      stage: 'debate',
      level: 'warn',
      message: 'debate.analyst_failure',
      payload: {
        debate_id: 'debate-1',
        analyst_id: 'analyst-sentiment-1',
        analyst_type: 'sentiment',
        reason: 'malformed output: missing confidence',
      },
    });
  });

  it('logDisagreement captures direction, summary, and open items', () => {
    const { sink, log } = makeSink();
    const logger = new JsonDebateLogger(sink);

    logger.logDisagreement({
      trace_id: 'trace-1',
      debate_id: 'debate-1',
      direction: 'bullish',
      disagreement_summary: 'Bear cites overextension; bull cites volume confirmation.',
      open_items: ['overextension risk unresolved'],
    });

    expect(log).toHaveBeenCalledWith({
      trace_id: 'trace-1',
      stage: 'debate',
      level: 'info',
      message: 'debate.disagreement',
      payload: {
        debate_id: 'debate-1',
        direction: 'bullish',
        disagreement_summary: 'Bear cites overextension; bull cites volume confirmation.',
        open_items: ['overextension risk unresolved'],
      },
    });
  });
});
