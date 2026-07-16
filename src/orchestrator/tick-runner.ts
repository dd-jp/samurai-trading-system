/**
 * Tick Runner (ticket #94) — see docs/specs/orchestrator-spec.md
 * (Module: Tick Runner).
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
 * The `current_tick` progress row the spec attaches to this module is #96's:
 * before each stage call `runInstrument` upserts the row for that stage, and
 * on every exit (short-circuit or final) it deletes it — see
 * docs/specs/orchestrator-spec.md's Tick Runner module.
 */
import type { Signal } from '../analysts/types.js';
import type { TickContext, TickOutcome, TickRunner, TickStage, TickSteps } from './types.js';

export class SequentialTickRunner implements TickRunner {
  constructor(private readonly steps: TickSteps) {}

  async runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome> {
    const { trace_id, clock, currentTickStore } = ctx;
    const instrument = signal.asset;

    const markStage = (stage: TickStage) =>
      currentTickStore?.upsert({
        instrument,
        asset_class: signal.asset_class,
        stage,
        trace_id,
        updated_at: clock.now(),
      });
    const clearStage = () => currentTickStore?.delete(instrument);

    await markStage('analysts');
    const views = await this.steps.analysts({ trace_id, signal, clock });
    if (views.length === 0) {
      await clearStage();
      return { trace_id, final_stage: 'analysts' };
    }

    await markStage('debate');
    const debate = await this.steps.debate({ trace_id, instrument, views, clock });

    await markStage('trader');
    const intent = await this.steps.trader({ trace_id, instrument, debate, clock });
    if (intent === null) {
      await clearStage();
      return { trace_id, final_stage: 'trader' };
    }

    await markStage('risk');
    const riskDecision = await this.steps.risk({ trace_id, intent, clock });
    if (riskDecision.status === 'rejected') {
      await clearStage();
      return { trace_id, final_stage: 'risk' };
    }

    await markStage('verdict');
    const verdict = await this.steps.verdict({ trace_id, risk_decision: riskDecision, clock });
    if (verdict.status !== 'go') {
      await clearStage();
      return { trace_id, final_stage: 'verdict', verdict_status: 'no_go' };
    }

    await markStage('execution');
    const execution_result = await this.steps.execution(verdict);
    await clearStage();
    return {
      trace_id,
      final_stage: 'execution',
      verdict_status: 'go',
      execution_result,
    };
  }
}
