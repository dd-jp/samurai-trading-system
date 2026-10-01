import { randomUUID } from 'node:crypto';
import type { Signal } from '../../pipeline/analysts/index.js';
import { LlmRefusalError } from '../../pipeline/debate-engine/index.js';
import type { Clock } from '../../shared/index.js';
import { describeThrown, digest, safeLog } from '../../shared/index.js';
import type { DecisionGate } from './decision-bar-gate.js';
import type {
  AuditLog,
  CurrentTickStore,
  DecisionBar,
  Logger,
  TickOutcome,
  TickPlan,
  TickRunner,
  TickStage,
  UniverseInstrument,
} from './types.js';

export interface TickLoopConfig {
  max_concurrent_instruments: number;
  newTraceId?: () => string;
  logger: Logger;
  auditLog: AuditLog;
  currentTickStore: CurrentTickStore;
  decisionGate: DecisionGate;
}

class TailSequencer {
  #turn = 0;
  #settled = new Set<number>();
  #granted = new Set<number>();
  #waiting = new Map<number, { promise: Promise<void>; resolve: () => void }>();

  begin(index: number): Promise<void> {
    if (this.#granted.has(index)) return Promise.resolve();
    if (index === this.#turn) {
      this.#granted.add(index);
      return Promise.resolve();
    }
    const pending = this.#waiting.get(index);
    if (pending !== undefined) return pending.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.#waiting.set(index, { promise, resolve });
    return promise;
  }

  finish(index: number): void {
    this.#settled.add(index);
    while (this.#settled.has(this.#turn)) this.#turn++;
    const waiter = this.#waiting.get(this.#turn);
    if (waiter !== undefined) {
      this.#waiting.delete(this.#turn);
      this.#granted.add(this.#turn);
      waiter.resolve();
    }
  }
}

export async function runTickPlan(
  plan: TickPlan,
  runner: TickRunner,
  clock: Clock,
  config: TickLoopConfig,
): Promise<TickOutcome[]> {
  const run: PlanRun = {
    plan,
    runner,
    clock,
    config,
    newTraceId: config.newTraceId ?? randomUUID,
    outcomes: Array.from<TickOutcome>({ length: plan.instruments.length }),
    tails: new TailSequencer(),
    cursor: 0,
  };
  const workerCount = Math.min(
    Math.max(Math.floor(config.max_concurrent_instruments), 1),
    plan.instruments.length,
  );

  await Promise.all(Array.from({ length: workerCount }, () => runPlanWorker(run)));

  return run.outcomes;
}

interface PlanRun {
  plan: TickPlan;
  runner: TickRunner;
  clock: Clock;
  config: TickLoopConfig;
  newTraceId: () => string;
  outcomes: TickOutcome[];
  tails: TailSequencer;
  cursor: number;
}

// Every allocated index must reach tails.finish, including the gate-claim throw path, which calls it
// before re-throwing (#1040)
async function runPlanWorker(run: PlanRun): Promise<void> {
  const { plan, runner, clock, config, outcomes, tails, newTraceId } = run;
  while (true) {
    const index = run.cursor++;
    const instrument = plan.instruments[index];
    if (instrument === undefined) return;

    const pass: InstrumentPass = {
      instrument,
      signal: { asset: instrument.asset, asset_class: instrument.asset_class },
      trace_id: newTraceId(),
    };

    const decisionBar = claimOrFinish(run, index, instrument.asset);

    try {
      outcomes[index] = await runner.runInstrument(pass.signal, {
        clock,
        trace_id: pass.trace_id,
        logger: config.logger,
        auditLog: config.auditLog,
        currentTickStore: config.currentTickStore,
        ...decisionBarField(decisionBar),
        beginPortfolioTail: () => tails.begin(index),
      });
    } catch (error) {
      outcomes[index] = settleCrashedPass(config, clock, pass, decisionBar, error);
    } finally {
      tails.finish(index);
    }
  }
}

function claimOrFinish(run: PlanRun, index: number, asset: string): DecisionBar | undefined {
  try {
    return claimDecisionBar(run.plan, run.config.decisionGate, asset);
  } catch (error) {
    run.tails.finish(index);
    throw error;
  }
}

interface InstrumentPass {
  instrument: UniverseInstrument;
  signal: Signal;
  trace_id: string;
}

export function claimDecisionBar(
  plan: TickPlan,
  gate: DecisionGate,
  asset: string,
): DecisionBar | undefined {
  return plan.grace_only === true ? undefined : gate.claim(asset, plan.tick_time);
}

export function decisionBarField(decisionBar: DecisionBar | undefined): {
  decision_bar?: DecisionBar;
} {
  return decisionBar === undefined ? {} : { decision_bar: decisionBar };
}

// The crash-handling guards (safeLog, the currentTickStore read, auditLog.record) exist so
// runPlanWorker() can never reject (#507's orphaned-worker leak)
function settleCrashedPass(
  config: TickLoopConfig,
  clock: Clock,
  pass: InstrumentPass,
  decisionBar: DecisionBar | undefined,
  error: unknown,
): TickOutcome {
  if (decisionBar !== undefined) releaseDecisionBar(config, pass, decisionBar, error);
  const message = describeThrown(error);
  const crashedStage = readCrashedStage(config.currentTickStore, pass);
  safeLog(config.logger, {
    trace_id: pass.trace_id,
    stage: 'tick-loop',
    event: 'instrument_pass_failed',
    level: 'error',
    message: `instrument failed: ${pass.instrument.asset}`,
    payload: {
      instrument: pass.instrument.asset,
      asset_class: pass.instrument.asset_class,
      error: message,
      stage: crashedStage,
    },
  });
  recordCrashAudit(config, clock, pass, crashedStage, message);
  return { trace_id: pass.trace_id, error: message };
}

function releaseDecisionBar(
  config: TickLoopConfig,
  pass: InstrumentPass,
  decisionBar: DecisionBar,
  error: unknown,
): void {
  const { instrument } = pass;
  const refused = error instanceof LlmRefusalError;
  const rescindResult = refused
    ? 'forfeited'
    : config.decisionGate.rescind(instrument.asset, decisionBar);
  if (rescindResult !== 'forfeited') return;
  safeLog(config.logger, {
    trace_id: pass.trace_id,
    stage: 'tick-loop',
    event: 'decision_pass_bar_forfeit',
    level: 'error',
    message: barForfeitMessage(refused, instrument.asset, decisionBar.id),
    payload: {
      instrument: instrument.asset,
      asset_class: instrument.asset_class,
      bar: decisionBar.id,
      reason: refused ? 'refusal' : 'retry_budget_exhausted',
    },
  });
}

export function barForfeitMessage(refused: boolean, asset: string, barId: string): string {
  return refused
    ? `decision pass refused by the provider, bar forfeit: ${asset} — ` +
        `bar ${barId} will run the tick path only for its remainder, and no ` +
        'retry is attempted because the refusal is deterministic in the request'
    : `decision pass retry budget exhausted, bar forfeit: ${asset} — ` +
        `bar ${barId} will run the tick path only for its remainder`;
}

export function readCrashedStage(
  store: CurrentTickStore,
  pass: Pick<InstrumentPass, 'instrument' | 'trace_id'>,
): TickStage | undefined {
  try {
    const currentTick = store.get(pass.instrument.asset);
    return currentTick?.trace_id === pass.trace_id ? currentTick.stage : undefined;
  } catch {
    return undefined;
  }
}

function recordCrashAudit(
  config: TickLoopConfig,
  clock: Clock,
  pass: InstrumentPass,
  crashedStage: TickStage | undefined,
  message: string,
): void {
  const { instrument, trace_id } = pass;
  try {
    config.auditLog.record({
      trace_id,
      stage: crashedStage === undefined ? 'tick-loop' : `tick-loop:${crashedStage}`,
      decision: 'crashed',
      input_digest: digest(pass.signal),
      output_digest: digest({ error: message }),
      timestamp: clock.now(),
      instrument: instrument.asset,
      asset_class: instrument.asset_class,
    });
  } catch (auditError) {
    safeLog(config.logger, {
      trace_id,
      stage: 'tick-loop',
      event: 'audit_log_write_failed',
      level: 'error',
      message: `audit_log record failed for crashed instrument: ${instrument.asset}`,
      payload: {
        instrument: instrument.asset,
        asset_class: instrument.asset_class,
        original_error: message,
        audit_error: describeThrown(auditError),
      },
    });
  }
}
