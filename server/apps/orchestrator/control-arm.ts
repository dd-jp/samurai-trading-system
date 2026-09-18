
import type { Signal } from '../../pipeline/analysts/index.js';
import {
  CONTROL_DEBATE_ID_PREFIX,
  CONTROL_TRACE_SUFFIX,
  controlArmDecision,
} from '../../pipeline/control-arm/index.js';
import type { AnalystView, DebateResult } from '../../pipeline/debate-engine/index.js';
import type { Logger } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import type { CurrentTick, CurrentTickStore, TickContext, TickRunner, TickSteps } from './types.js';

export { CONTROL_TRACE_SUFFIX };

export class AnalystViewRelay {
  readonly #views = new Map<string, readonly AnalystView[]>();

  set(trace_id: string, views: readonly AnalystView[]): void {
    this.#views.set(trace_id, views);
  }

  clear(trace_id: string): void {
    this.#views.delete(trace_id);
  }

  get(trace_id: string): AnalystView[] {
    return [...(this.#views.get(trace_id) ?? [])];
  }
}

export function buildControlAnalystsStep(relay: AnalystViewRelay): TickSteps['analysts'] {
  return async ({ trace_id }) => relay.get(trace_id);
}

export function buildControlDebateStep(relay: AnalystViewRelay): TickSteps['debate'] {
  return async ({ trace_id, instrument, bar }): Promise<DebateResult> => {
    const views = relay.get(trace_id);
    const decision = controlArmDecision({ instrument, views, bar });
    if (decision !== null) return decision;

    return {
      direction: 'neutral',
      confidence: 0,
      bar_timestamp: bar,
      debate_id: `${CONTROL_DEBATE_ID_PREFIX}no-axis-vote:${instrument}:${bar.toISOString()}`,
      converged: true,
      rounds_completed: 0,
      latency_ms: 0,
      contributions: [],
      open_items: [],
      synthesis:
        'Falsifier arm 2 (#753): the technical analyst produced no view for this pass, so the ' +
        'deterministic axis vote had nothing to read. No entry.',
      position: 'No position — no axis vote available.',
      disagreement_summary: 'No debate was held; the control arm holds no debate.',
      read: true,
    };
  };
}

export class InMemoryCurrentTickStore implements CurrentTickStore {
  readonly #rows = new Map<string, CurrentTick>();

  upsert(row: CurrentTick): void {
    this.#rows.set(row.instrument, row);
  }

  delete(instrument: string): void {
    this.#rows.delete(instrument);
  }

  get(instrument: string): CurrentTick | undefined {
    return this.#rows.get(instrument);
  }
}

export interface ControlArmDeps {
  runner: TickRunner;
  relay: AnalystViewRelay;
  currentTickStore: CurrentTickStore;
  logger: Logger;
}

export type ControlArmStep = (input: {
  signal: Signal;
  ctx: TickContext;
  views?: readonly AnalystView[];
}) => Promise<void>;

export function buildControlArmStep(deps: ControlArmDeps): ControlArmStep {
  return async ({ signal, ctx, views }) => {
    const trace_id = `${ctx.trace_id}${CONTROL_TRACE_SUFFIX}`;
    if (views !== undefined) deps.relay.set(trace_id, views);

    try {
      await deps.runner.runInstrument(signal, {
        clock: ctx.clock,
        trace_id,
        logger: ctx.logger,
        auditLog: ctx.auditLog,
        currentTickStore: deps.currentTickStore,
        ...(ctx.decision_bar === undefined ? {} : { decision_bar: ctx.decision_bar }),
      });
    } catch (error) {
      deps.logger.log({
        trace_id,
        stage: 'control_arm',
        event: 'control_arm_pass_failed',
        level: 'error',
        message:
          `control arm: ${signal.asset} — the control pass failed and was contained. The live ` +
          'arm is unaffected, but falsifier arm 2 produced no decision for this tick, and a ' +
          'control that stops producing cannot answer the debate-beats-indicators question at ' +
          'the end of the soak (#753).',
        payload: {
          instrument: signal.asset,
          error: describeThrownSafely(error),
        },
      });
    } finally {
      deps.relay.clear(trace_id);
    }
  };
}
