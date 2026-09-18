import type { Signal } from '../../pipeline/analysts/index.js';
import { DEBATE_BAR_TIMEFRAME_MS, floorToBar } from '../../pipeline/debate-engine/index.js';
import { digest, type OrderIntent, runWithTraceId } from '../../shared/index.js';
import { analystsSkipDecisionWord } from './analysts-decision.js';
import { debateDecisionWord, isDegradedDecision } from './debate-decision.js';
import type { TickContext, TickOutcome, TickRunner, TickStage, TickSteps } from './types.js';

export class SequentialTickRunner implements TickRunner {
  readonly #lastAdvisory = new Map<string, string>();

  constructor(private readonly steps: TickSteps) {}

  async runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome> {
    return runWithTraceId(ctx.trace_id, () => this.#runInstrument(signal, ctx));
  }

  async #runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome> {
    const { trace_id, clock, logger, auditLog, currentTickStore } = ctx;
    const instrument = signal.asset;

    const startStageTimer = () => ({ wallMs: Date.now(), perfMs: performance.now() });

    const recordLevel = (
      stage: TickStage,
      decision: string,
    ): 'debug' | 'info' | 'warn' | 'error' => {
      if (stage === 'execution' && decision === 'error') {
        return 'error';
      }
      if (stage === 'position_check' && decision === 'no_exit_due') {
        return 'debug';
      }
      return isDegradedDecision(decision) ? 'warn' : 'info';
    };

    const record = (
      stage: TickStage,
      decision: string,
      input: unknown,
      output: unknown,
      startedAt: { wallMs: number; perfMs: number },
    ) => {
      const duration_ms = performance.now() - startedAt.perfMs;
      logger.log({
        trace_id,
        stage,
        event: 'stage_decision',
        level: recordLevel(stage, decision),
        message: `${stage}: ${decision}`,
        payload: output,
        started_at: new Date(startedAt.wallMs).toISOString(),
        duration_ms,
      });
      auditLog.record({
        trace_id,
        stage,
        decision,
        input_digest: digest(input),
        output_digest: digest(output),
        timestamp: clock.now(),
        instrument,
        asset_class: signal.asset_class,
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

    const runIntentTail = async (
      intent: OrderIntent,
      extras: Pick<TickOutcome, 'early_exit_fired' | 'flatten_fired'>,
    ): Promise<TickOutcome> => {
      markStage('risk');
      const riskInput = { trace_id, intent, clock };
      const riskTimer = startStageTimer();
      const riskDecision = await this.steps.risk(riskInput);
      record('risk', riskDecision.status, riskInput, riskDecision, riskTimer);
      this.reportAdvisoryWarnings(instrument, riskDecision.warnings, ctx);
      if (riskDecision.status === 'rejected') {
        currentTickStore.delete(instrument);
        return { trace_id, final_stage: 'risk', ...extras };
      }

      markStage('verdict');
      const verdictInput = { trace_id, risk_decision: riskDecision, clock };
      const verdictTimer = startStageTimer();
      const verdict = await this.steps.verdict(verdictInput);
      record('verdict', verdict.status, verdictInput, verdict, verdictTimer);
      if (verdict.status !== 'go') {
        currentTickStore.delete(instrument);
        return { trace_id, final_stage: 'verdict', verdict_status: 'no_go', ...extras };
      }

      markStage('execution');
      const executionTimer = startStageTimer();
      const executionResult = await this.steps.execution(verdict);
      record('execution', executionResult.status, verdict, executionResult, executionTimer);

      currentTickStore.delete(instrument);
      return {
        trace_id,
        final_stage: 'execution',
        verdict_status: 'go',
        execution_result: executionResult,
        ...extras,
      };
    };

    const runExitCheckPass = async (bar: Date): Promise<TickOutcome> => {
      markStage('position_check');
      const exitInput = { trace_id, instrument, bar, clock };
      const exitCheckTimer = startStageTimer();
      const exitIntent = await this.steps.exitCheck(exitInput);
      record(
        'position_check',
        exitIntent === null ? 'no_exit_due' : (exitIntent.metadata.exit_reason ?? 'exit'),
        exitInput,
        exitIntent,
        exitCheckTimer,
      );
      if (exitIntent === null) {
        currentTickStore.delete(instrument);
        return { trace_id, final_stage: 'position_check' };
      }
      await ctx.beginPortfolioTail?.();
      return runIntentTail(
        exitIntent,
        exitIntent.metadata.exit_reason === 'signal_decay'
          ? { early_exit_fired: true }
          : { flatten_fired: true },
      );
    };

    const decisionBar = ctx.decision_bar;
    if (decisionBar === undefined) {
      await this.steps.controlArm?.({ signal, ctx });
      return runExitCheckPass(floorToBar(clock.now(), DEBATE_BAR_TIMEFRAME_MS));
    }

    markStage('analysts');
    const analystsInput = { trace_id, signal, clock, bar: decisionBar.open_time };
    const analystsTimer = startStageTimer();
    const views = await this.steps.analysts(analystsInput);
    const analystsDecision =
      views.length === 0
        ? analystsSkipDecisionWord(this.steps.analystSkipKind?.(trace_id))
        : 'quorum_met';
    record('analysts', analystsDecision, analystsInput, views, analystsTimer);

    await this.steps.controlArm?.({ signal, ctx, views });

    if (views.length === 0) {
      return runExitCheckPass(decisionBar.open_time);
    }

    markStage('debate');
    const debateInput = {
      trace_id,
      instrument,
      asset_class: signal.asset_class,
      views,
      clock,
      bar: decisionBar.open_time,
    };
    const debateTimer = startStageTimer();
    const debate = await this.steps.debate(debateInput);
    record('debate', debateDecisionWord(debate), debateInput, debate, debateTimer);

    if (debate.bar_timestamp.getTime() !== decisionBar.open_time.getTime()) {
      logger.log({
        trace_id,
        stage: 'debate',
        event: 'decision_bar_divergence',
        level: 'warn',
        message:
          `debate: ${instrument} — decision bar divergence: the gate opened bar ` +
          `${decisionBar.open_time.toISOString()} but the debate result claims ` +
          `${debate.bar_timestamp.toISOString()}. Any intent this pass produces will key to ` +
          "the debate's bar, not the gate's, and may be suppressed as a duplicate — a " +
          'suppressed entry is otherwise indistinguishable from a no-trade tick (#687/#743).',
        payload: {
          instrument,
          gate_bar: decisionBar.open_time.toISOString(),
          debate_bar: debate.bar_timestamp.toISOString(),
          debate_id: debate.debate_id,
        },
      });
    }

    await ctx.beginPortfolioTail?.();

    markStage('trader');
    const traderInput = { trace_id, instrument, debate, clock };
    const traderTimer = startStageTimer();
    const intent = await this.steps.trader(traderInput);
    record(
      'trader',
      intent === null ? 'no_trade' : intent.intent_type,
      traderInput,
      intent,
      traderTimer,
    );
    if (intent === null) {
      currentTickStore.delete(instrument);
      return { trace_id, final_stage: 'trader' };
    }

    return runIntentTail(intent, {});
  }

  private reportAdvisoryWarnings(instrument: string, warnings: string[], ctx: TickContext): void {
    const signature = [...warnings].sort().join('|');
    if (this.#lastAdvisory.get(instrument) === signature) return;

    const hadWarnings = (this.#lastAdvisory.get(instrument) ?? '') !== '';
    if (warnings.length === 0 && !hadWarnings) return;
    this.#lastAdvisory.set(instrument, signature);

    ctx.logger.log({
      trace_id: ctx.trace_id,
      stage: 'risk',
      event: 'risk_advisory_warnings',
      level: warnings.length > 0 ? 'warn' : 'info',
      message:
        warnings.length > 0
          ? `risk: ${instrument} — advisory warnings: ${warnings.join(', ')}`
          : `risk: ${instrument} — advisory warnings cleared`,
      payload: { instrument, warnings, advisory: true },
    });
  }
}
