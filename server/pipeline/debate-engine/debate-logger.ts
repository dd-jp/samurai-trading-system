import type { Logger } from '../../shared/index.js';
import type { AnalystView, DebateResult, Direction } from './types.js';

export type LogSink = Logger;

export interface DebateAnalystFailure {
  analyst_id: string;
  analyst_type: string;
  reason: string;
}

export type DebatePersona = 'bull' | 'bear' | 'mediator';

export interface DebateLogger {
  logInputs(entry: {
    trace_id: string;
    debate_id: string;
    views: AnalystView[];
    failures: DebateAnalystFailure[];
  }): void;

  logRound(entry: {
    trace_id: string;
    debate_id: string;
    round: number;
    persona: DebatePersona;
    statement: string;
    timestamp: Date;
  }): void;

  logOutput(entry: { trace_id: string; debate_id: string; result: DebateResult }): void;

  logLatency(entry: {
    trace_id: string;
    debate_id: string;
    latency_ms: number;
    budget_ms: number;
  }): void;

  logTimeout(entry: {
    trace_id: string;
    debate_id: string;
    elapsed_ms: number;
    budget_ms: number;
    reason: string;
  }): void;

  logAnalystFailure(entry: {
    trace_id: string;
    debate_id: string;
    failure: DebateAnalystFailure;
  }): void;

  logDisagreement(entry: {
    trace_id: string;
    debate_id: string;
    direction: Direction;
    disagreement_summary: string;
    open_items: string[];
  }): void;
}

export class JsonDebateLogger implements DebateLogger {
  constructor(private readonly sink: LogSink) {}

  logInputs(entry: {
    trace_id: string;
    debate_id: string;
    views: AnalystView[];
    failures: DebateAnalystFailure[];
  }): void {
    this.sink.log({
      trace_id: entry.trace_id,
      stage: 'debate',
      level: 'info',
      message: 'debate.inputs',
      payload: {
        debate_id: entry.debate_id,
        views: entry.views,
        failures: entry.failures,
      },
    });
  }

  logRound(entry: {
    trace_id: string;
    debate_id: string;
    round: number;
    persona: DebatePersona;
    statement: string;
    timestamp: Date;
  }): void {
    this.sink.log({
      trace_id: entry.trace_id,
      stage: 'debate',
      level: 'info',
      message: 'debate.round',
      payload: {
        debate_id: entry.debate_id,
        round: entry.round,
        persona: entry.persona,
        statement: entry.statement,
        timestamp: entry.timestamp,
      },
    });
  }

  logOutput(entry: { trace_id: string; debate_id: string; result: DebateResult }): void {
    this.sink.log({
      trace_id: entry.trace_id,
      stage: 'debate',
      level: 'info',
      message: 'debate.output',
      payload: {
        debate_id: entry.debate_id,
        result: entry.result,
      },
    });
  }

  logLatency(entry: {
    trace_id: string;
    debate_id: string;
    latency_ms: number;
    budget_ms: number;
  }): void {
    this.sink.log({
      trace_id: entry.trace_id,
      stage: 'debate',
      event: 'debate_latency',
      level: entry.latency_ms > entry.budget_ms ? 'warn' : 'info',
      message: 'debate.latency',
      payload: {
        debate_id: entry.debate_id,
        latency_ms: entry.latency_ms,
        budget_ms: entry.budget_ms,
      },
    });
  }

  logTimeout(entry: {
    trace_id: string;
    debate_id: string;
    elapsed_ms: number;
    budget_ms: number;
    reason: string;
  }): void {
    this.sink.log({
      trace_id: entry.trace_id,
      stage: 'debate',
      event: 'debate_timeout',
      level: 'warn',
      message: 'debate.timeout',
      payload: {
        debate_id: entry.debate_id,
        elapsed_ms: entry.elapsed_ms,
        budget_ms: entry.budget_ms,
        reason: entry.reason,
      },
    });
  }

  logAnalystFailure(entry: {
    trace_id: string;
    debate_id: string;
    failure: DebateAnalystFailure;
  }): void {
    this.sink.log({
      trace_id: entry.trace_id,
      stage: 'debate',
      event: 'debate_analyst_failure',
      level: 'warn',
      message: 'debate.analyst_failure',
      payload: {
        debate_id: entry.debate_id,
        analyst_id: entry.failure.analyst_id,
        analyst_type: entry.failure.analyst_type,
        reason: entry.failure.reason,
      },
    });
  }

  logDisagreement(entry: {
    trace_id: string;
    debate_id: string;
    direction: Direction;
    disagreement_summary: string;
    open_items: string[];
  }): void {
    this.sink.log({
      trace_id: entry.trace_id,
      stage: 'debate',
      level: 'info',
      message: 'debate.disagreement',
      payload: {
        debate_id: entry.debate_id,
        direction: entry.direction,
        disagreement_summary: entry.disagreement_summary,
        open_items: entry.open_items,
      },
    });
  }
}
