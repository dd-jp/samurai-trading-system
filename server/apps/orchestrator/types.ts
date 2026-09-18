import type { Signal } from '../../pipeline/analysts/index.js';
import type { AnalystView, DebateResult } from '../../pipeline/debate-engine/index.js';
import type { ExecutionResult } from '../../pipeline/execution/index.js';
import type { RiskDecision } from '../../pipeline/risk-manager/index.js';
import type { VerdictDecision } from '../../pipeline/verdict/index.js';
import type { AssetClass, Clock, InstrumentSubclass, OrderIntent } from '../../shared/index.js';
import type { AnalystSkipKind } from './analysts-decision.js';

export type { AssetClass, InstrumentSubclass };

export interface UniverseInstrument {
  asset: string;
  asset_class: AssetClass;
  subclass?: InstrumentSubclass;
}

export function subclassOfUniverse(
  universe: readonly UniverseInstrument[],
): Record<string, InstrumentSubclass> {
  return Object.fromEntries(
    universe.flatMap((instrument) =>
      instrument.subclass === undefined ? [] : [[instrument.asset, instrument.subclass] as const],
    ),
  );
}

export interface TickPlan {
  instruments: UniverseInstrument[];
  tick_time: Date;
  grace_only?: boolean;
}

export interface Scheduler {
  nextTick(clock: Clock): TickPlan;
}

import type { LogEntry, Logger } from '../../shared/index.js';

export type { LogEntry, Logger };

export interface AuditLog {
  record(entry: {
    trace_id: string;
    stage: string;
    decision: string;
    input_digest: string;
    output_digest: string;
    timestamp: Date;
    instrument?: string;
    asset_class?: AssetClass;
  }): void;
}

export type TickStage =
  | 'position_check'
  | 'analysts'
  | 'debate'
  | 'trader'
  | 'risk'
  | 'verdict'
  | 'execution';

export interface DecisionBar {
  id: string;
  open_time: Date;
  timeframe_ms: number;
}

export interface CurrentTick {
  instrument: string;
  asset_class: AssetClass;
  stage: TickStage;
  trace_id: string;
  updated_at: Date;
}

export interface CurrentTickStore {
  upsert(row: CurrentTick): void;
  delete(instrument: string): void;
  get(instrument: string): CurrentTick | undefined;
}

export interface TickContext {
  clock: Clock;
  trace_id: string;
  logger: Logger;
  auditLog: AuditLog;
  currentTickStore: CurrentTickStore;
  decision_bar?: DecisionBar;
  beginPortfolioTail?: () => Promise<void>;
}

export interface TickOutcome {
  trace_id: string;
  final_stage?: TickStage;
  verdict_status?: 'go' | 'no_go';
  execution_result?: ExecutionResult;
  flatten_fired?: boolean;
  early_exit_fired?: boolean;
  error?: string;
}

export interface TickSteps {
  exitCheck(input: {
    trace_id: string;
    instrument: string;
    bar: Date;
    clock: Clock;
  }): Promise<OrderIntent | null>;
  analysts(input: {
    trace_id: string;
    signal: Signal;
    clock: Clock;
    bar: Date;
  }): Promise<AnalystView[]>;
  analystSkipKind?(trace_id: string): AnalystSkipKind | undefined;
  debate(input: {
    trace_id: string;
    instrument: string;
    asset_class: AssetClass;
    views: AnalystView[];
    clock: Clock;
    bar: Date;
  }): Promise<DebateResult>;
  trader(input: {
    trace_id: string;
    instrument: string;
    debate: DebateResult;
    clock: Clock;
  }): Promise<OrderIntent | null>;
  risk(input: { trace_id: string; intent: OrderIntent; clock: Clock }): Promise<RiskDecision>;
  verdict(input: {
    trace_id: string;
    risk_decision: RiskDecision;
    clock: Clock;
  }): Promise<VerdictDecision>;
  execution(verdict: VerdictDecision): Promise<ExecutionResult>;
  controlArm?(input: {
    signal: Signal;
    ctx: TickContext;
    views?: readonly AnalystView[];
  }): Promise<void>;
}

export interface TickRunner {
  runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome>;
}
