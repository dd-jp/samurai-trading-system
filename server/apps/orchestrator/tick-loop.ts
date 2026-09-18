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
  const newTraceId = config.newTraceId ?? randomUUID;
  const outcomes = Array.from<TickOutcome>({ length: plan.instruments.length });

  let cursor = 0;
  const tails = new TailSequencer();
  const workerCount = Math.min(
    Math.max(Math.floor(config.max_concurrent_instruments), 1),
    plan.instruments.length,
  );

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: every allocated index must reach tails.finish (including the gate-claim throw path, which calls it before re-throwing, #1040) and the crash-handling guards (safeLog, currentTickStore read, auditLog.record) exist so worker() can never reject (#507's orphaned-worker leak) — both invariants are compiler-invisible and an extraction deep enough to matter would take several more cuts through code an earlier session already called untouchable
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      const instrument = plan.instruments[index];
      if (instrument === undefined) return;

      const signal: Signal = {
        asset: instrument.asset,
        asset_class: instrument.asset_class,
      };
      const trace_id = newTraceId();

      let decisionBar: DecisionBar | undefined;
      try {
        decisionBar =
          plan.grace_only === true
            ? undefined
            : config.decisionGate.claim(instrument.asset, plan.tick_time);
      } catch (error) {
        tails.finish(index);
        throw error;
      }

      try {
        outcomes[index] = await runner.runInstrument(signal, {
          clock,
          trace_id,
          logger: config.logger,
          auditLog: config.auditLog,
          currentTickStore: config.currentTickStore,
          ...(decisionBar === undefined ? {} : { decision_bar: decisionBar }),
          beginPortfolioTail: () => tails.begin(index),
        });
      } catch (error) {
        if (decisionBar !== undefined) {
          const refused = error instanceof LlmRefusalError;
          const rescindResult = refused
            ? 'forfeited'
            : config.decisionGate.rescind(instrument.asset, decisionBar);
          if (rescindResult === 'forfeited') {
            safeLog(config.logger, {
              trace_id,
              stage: 'tick-loop',
              event: 'decision_pass_bar_forfeit',
              level: 'error',
              message: refused
                ? `decision pass refused by the provider, bar forfeit: ${instrument.asset} — ` +
                  `bar ${decisionBar.id} will run the tick path only for its remainder, and no ` +
                  'retry is attempted because the refusal is deterministic in the request'
                : `decision pass retry budget exhausted, bar forfeit: ${instrument.asset} — ` +
                  `bar ${decisionBar.id} will run the tick path only for its remainder`,
              payload: {
                instrument: instrument.asset,
                asset_class: instrument.asset_class,
                bar: decisionBar.id,
                reason: refused ? 'refusal' : 'retry_budget_exhausted',
              },
            });
          }
        }
        const message = describeThrown(error);
        let crashedStage: TickStage | undefined;
        try {
          const currentTick = config.currentTickStore.get(instrument.asset);
          crashedStage = currentTick?.trace_id === trace_id ? currentTick.stage : undefined;
        } catch {}
        safeLog(config.logger, {
          trace_id,
          stage: 'tick-loop',
          event: 'instrument_pass_failed',
          level: 'error',
          message: `instrument failed: ${instrument.asset}`,
          payload: {
            instrument: instrument.asset,
            asset_class: instrument.asset_class,
            error: message,
            stage: crashedStage,
          },
        });
        try {
          config.auditLog.record({
            trace_id,
            stage: crashedStage === undefined ? 'tick-loop' : `tick-loop:${crashedStage}`,
            decision: 'crashed',
            input_digest: digest(signal),
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
        outcomes[index] = { trace_id, error: message };
      } finally {
        tails.finish(index);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return outcomes;
}
