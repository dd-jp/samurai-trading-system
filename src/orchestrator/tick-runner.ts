/**
 * Tick Runner (ticket #94, audit/log wiring #95) — see
 * docs/specs/orchestrator-spec.md (Module: Tick Runner, Module: Structured
 * Logging & Audit Spine).
 *
 * Drives one instrument's pass: Analysts -> Debate -> Trader -> Risk ->
 * Verdict -> (on `go`) Execution. A straight-line sequential chain over the
 * already-specced stage contracts — no stage decision logic lives here.
 *
 * Four short-circuit exits, each returning the stage that ended the pass:
 *   analysts — empty view set (quorum skip, analysts-spec.md story 21)
 *   trader   — null intent (no-trade; `Trader.decide` is `OrderIntent | null`)
 *   risk     — `rejected`
 *   verdict  — `no_go`
 * Execution is unreachable from all four, which is the gate-vs-actor
 * separation (orchestrator-spec.md story 7) this ticket must guarantee.
 *
 * Every stage actually reached emits exactly one `logger.log` line and one
 * `auditLog.record` row, both carrying `trace_id` — a short-circuited stage
 * and everything after it produce no row (there is no decision to record).
 *
 * The `current_tick` progress row the spec attaches to this module (#96):
 * upserted before each stage call, deleted on every normal terminal return.
 * Deliberately not wrapped in try/finally — a thrown error (crash mid-tick)
 * must leave the row stale rather than clean it up, since the acceptance
 * criterion is that a stale row is safely overwritten next tick, not that a
 * crash is invisible.
 */
import type { Signal } from '../analysts/types.js';
import { digest } from './digest.js';
import type { TickContext, TickOutcome, TickRunner, TickStage, TickSteps } from './types.js';

export class SequentialTickRunner implements TickRunner {
  constructor(private readonly steps: TickSteps) {}

  async runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome> {
    const { trace_id, clock, logger, auditLog, currentTickStore } = ctx;
    const instrument = signal.asset;

    const record = (stage: TickStage, decision: string, input: unknown, output: unknown) => {
      logger.log({
        trace_id,
        stage,
        level: 'info',
        message: `${stage}: ${decision}`,
        payload: output,
      });
      auditLog.record({
        trace_id,
        stage,
        decision,
        input_digest: digest(input),
        output_digest: digest(output),
        timestamp: clock.now(),
      });
    };

    const markStage = (stage: TickStage) => {
      currentTickStore.upsert({
        instrument,
        asset_class: signal.asset_class,
        stage,
        trace_id,
        updated_at: clock.now(),
      });
    };

    markStage('analysts');
    const analystsInput = { trace_id, signal, clock };
    const views = await this.steps.analysts(analystsInput);
    record('analysts', views.length === 0 ? 'quorum_skip' : 'quorum_met', analystsInput, views);
    if (views.length === 0) {
      currentTickStore.delete(instrument);
      return { trace_id, final_stage: 'analysts' };
    }

    markStage('debate');
    const debateInput = { trace_id, instrument, views, clock };
    const debate = await this.steps.debate(debateInput);
    record('debate', debate.direction, debateInput, debate);

    markStage('trader');
    const traderInput = { trace_id, instrument, debate, clock };
    const intent = await this.steps.trader(traderInput);
    record('trader', intent === null ? 'no_trade' : intent.intent_type, traderInput, intent);
    if (intent === null) {
      currentTickStore.delete(instrument);
      return { trace_id, final_stage: 'trader' };
    }

    markStage('risk');
    const riskInput = { trace_id, intent, clock };
    const riskDecision = await this.steps.risk(riskInput);
    record('risk', riskDecision.status, riskInput, riskDecision);
    if (riskDecision.status === 'rejected') {
      currentTickStore.delete(instrument);
      return { trace_id, final_stage: 'risk' };
    }

    markStage('verdict');
    const verdictInput = { trace_id, risk_decision: riskDecision, clock };
    const verdict = await this.steps.verdict(verdictInput);
    record('verdict', verdict.status, verdictInput, verdict);
    if (verdict.status !== 'go') {
      currentTickStore.delete(instrument);
      return { trace_id, final_stage: 'verdict', verdict_status: 'no_go' };
    }

    markStage('execution');
    const executionResult = await this.steps.execution(verdict);
    record('execution', executionResult.status, verdict, executionResult);

    currentTickStore.delete(instrument);
    return {
      trace_id,
      final_stage: 'execution',
      verdict_status: 'go',
      execution_result: executionResult,
    };
  }
}
