/**
 * `DebateLogger` (#38) — see docs/specs/debate-engine-spec.md (story 20:
 * "log every debate... so I can audit decisions and tune weights in the
 * Feedback Loop").
 *
 * Distinct from the `DebateLog` persisted analytics record (spec's "Debate
 * log write", Feedback Loop's system-of-record) — that is a single
 * append-only row written once per completed debate, out of scope here.
 * `DebateLogger` is the ephemeral, fine-grained observability spine: one
 * structured JSON line per lifecycle event (inputs, each round, output,
 * latency, timeouts, analyst failures), for auditing/tuning, not for
 * downstream joins.
 *
 * `LogSink` is declared locally rather than importing `Logger` from
 * `orchestrator/types.ts` — orchestrator already imports types from
 * debate-engine (`AnalystView`, `DebateResult`), so importing the other way
 * would be backwards. The shape is identical by design: `JsonLogger`
 * (orchestrator/logger.ts) satisfies `LogSink` structurally with no import
 * needed, so the concrete stdout-JSON sink is reused for free at wiring time.
 */
import type { AnalystView, DebateResult, Direction } from './types.js';

export interface LogSink {
  log(entry: {
    trace_id: string;
    stage: string;
    level: 'info' | 'warn' | 'error';
    message: string;
    payload?: unknown;
  }): void;
}

/**
 * A single analyst's failure to contribute a usable view to this debate
 * (quorum/timeout handling, spec's "Module: Analyst Failure Handling").
 * Distinct from the Analysts layer's `AnalystFailure` (analyst_type + role)
 * — this is debate-scoped and identifies the specific analyst instance.
 */
export interface DebateAnalystFailure {
  analyst_id: string;
  analyst_type: string;
  reason: string;
}

export type DebatePersona = 'bull' | 'bear' | 'mediator';

export interface DebateLogger {
  /** Story 20 / AC: inputs — AnalystViews received and which analysts failed. */
  logInputs(entry: {
    trace_id: string;
    debate_id: string;
    views: AnalystView[];
    failures: DebateAnalystFailure[];
  }): void;

  /** AC: rounds — what each persona said, when. */
  logRound(entry: {
    trace_id: string;
    debate_id: string;
    round: number;
    persona: DebatePersona;
    statement: string;
    timestamp: Date;
  }): void;

  /** AC: output — the full DebateResult. */
  logOutput(entry: { trace_id: string; debate_id: string; result: DebateResult }): void;

  /** AC: latency metrics — actual wall-clock time vs budget. */
  logLatency(entry: {
    trace_id: string;
    debate_id: string;
    latency_ms: number;
    budget_ms: number;
  }): void;

  /** AC: timeout events — budget exceeded, debate terminated early. */
  logTimeout(entry: {
    trace_id: string;
    debate_id: string;
    elapsed_ms: number;
    budget_ms: number;
    reason: string;
  }): void;

  /** AC: analyst failures with reasons. */
  logAnalystFailure(entry: {
    trace_id: string;
    debate_id: string;
    failure: DebateAnalystFailure;
  }): void;

  /** AC: disagreements detected (spec's semantic disagreement detection). */
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
