/**
 * Drives one instrument's pass, on one of two cadences: a tick pass (every
 * tick) runs only the position-facing exit check, then Risk -> Verdict ->
 * Execution if it produced an intent; a decision pass (`ctx.decision_bar`
 * set, once per debate bar) runs the full Analysts -> Debate -> Trader ->
 * Risk -> Verdict -> Execution chain.
 *
 * Exactly one Trader entry point runs per pass: a decision pass that reaches
 * the Trader evaluates the flatten window there (`decide.ts`, #668), so it
 * must not also run the tick path's exit check, or the same exit would be
 * emitted twice. A decision pass that short-circuits BEFORE the Trader (a
 * quorum skip) has no entry point to carry the flatten, so it runs the exit
 * check itself instead (`runExitCheckPass`, #785) — the one place that
 * evaluates a flatten, shared by both callers.
 *
 * ## Phase split (#1040)
 *
 * Each pass has a portfolio-free HEAD (safe to overlap across instruments)
 * and a TAIL that reads/mutates the book and must not overlap, because
 * `RiskManager.evaluate()` reads a snapshot and two concurrent instruments
 * would each clear the gross cap against pre-trade exposure and breach it
 * combined (#1019). The boundary is `await ctx.beginPortfolioTail?.()`; its
 * ordering lives in `tick-loop.ts`, which the runner must not know about.
 *
 * The bar coordinate (#687/#743): a decision pass keys everything off
 * `ctx.decision_bar`; the Trader inherits it via `DebateResult.bar_timestamp`,
 * and a mismatch is logged loudly since it means a suppressed entry that
 * otherwise looks like a healthy no-trade tick.
 *
 * Every stage reached emits one `logger.log` line and one `auditLog.record`
 * row; a short-circuited stage produces neither for itself or anything
 * after. Two exceptions: an advisory-warning transition emits a second risk
 * line with no audit row (`reportAdvisoryWarnings`), and a `no_exit_due`
 * position_check still writes its audit row but logs at `debug` (`recordLevel`).
 *
 * The `current_tick` progress row is upserted before each stage and deleted
 * on every normal return, deliberately NOT in try/finally: a crash must
 * leave it stale so it is visibly overwritten next tick, not silently cleaned up.
 */
import type { Signal } from '../../pipeline/analysts/index.js';
import { DEBATE_BAR_TIMEFRAME_MS, floorToBar } from '../../pipeline/debate-engine/index.js';
import { type OrderIntent, runWithTraceId } from '../../shared/index.js';
import { analystsSkipDecisionWord } from './analysts-decision.js';
import { debateDecisionWord, isDegradedDecision } from './debate-decision.js';
import { digest } from './digest.js';
import type { TickContext, TickOutcome, TickRunner, TickStage, TickSteps } from './types.js';

export class SequentialTickRunner implements TickRunner {
  /**
   * Last advisory-warning set emitted per instrument, so the advisory line
   * marks a CHANGE rather than repeating state (#303). In-memory and not
   * persisted on purpose — a restart re-announcing state once is fine.
   */
  readonly #lastAdvisory = new Map<string, string>();

  constructor(private readonly steps: TickSteps) {}

  /** Publishes `trace_id` as ambient context so log sites with no channel to receive one (`TokenBucket`, `MarketDataService`) can still name the tick */
  async runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome> {
    return runWithTraceId(ctx.trace_id, () => this.#runInstrument(signal, ctx));
  }

  async #runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome> {
    const { trace_id, clock, logger, auditLog, currentTickStore } = ctx;
    const instrument = signal.asset;

    // wallMs (real Date.now, not the backtest-steppable clock) for started_at;
    // perfMs (monotonic performance.now, immune to NTP step-back) for duration
    // Named fields, not two positional numbers, since the two are trivially
    // transposable as bare `number` params
    const startStageTimer = () => ({ wallMs: Date.now(), perfMs: performance.now() });

    /**
     * A degraded decision (#1080, `DEGRADED_DECISIONS` in contracts/pipeline.ts)
     * means a resource control produced this stage's output instead of the
     * market — logging it at `info` is how 22 of 26 starved debates went
     * unnoticed for a full session. Routine outcomes (Risk vetoes, Verdict
     * `no_go`) stay at `info`.
     */
    const recordLevel = (
      stage: TickStage,
      decision: string,
    ): 'debug' | 'info' | 'warn' | 'error' => {
      if (stage === 'execution' && decision === 'error') {
        return 'error';
      }
      // #1113: no_exit_due is ~29 of 30 passes and carries no information the
      // audit row (written regardless of level) doesn't already have, so it's
      // quieted to `debug` rather than dropped
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
        // Without these, a tick that stopped at Analysts or Risk was
        // unattributable to an instrument: neither current_tick nor
        // verdict_log covered it
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

    /**
     * The shared Risk -> Verdict -> Execution tail both paths converge on once
     * an intent exists, so gate-vs-actor separation (Execution only on `go`)
     * is enforced in exactly one place
     */
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

    /**
     * The position-facing exit check (#743, extracted for #785): input
     * carries no analysts/debate output, by construction. Shared by the tick
     * path and a quorum-skipped decision pass — the two callers with no
     * Trader entry point of their own to carry the flatten.
     */
    const runExitCheckPass = async (bar: Date): Promise<TickOutcome> => {
      markStage('position_check');
      const exitInput = { trace_id, instrument, bar, clock };
      const exitCheckTimer = startStageTimer();
      const exitIntent = await this.steps.exitCheck(exitInput);
      // #748: names which kind of exit fired — `flatten` and `signal_decay`
      // are different events and must not share one audit string
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
      // Phase split (#1040): the turn is taken here, not at the top of the
      // check, since the exit check itself reads no portfolio state — taking
      // it earlier would queue every no-intent tick pass (~29 of 30) behind
      // every instrument ahead of it in the plan for nothing
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
      // Falsifier arm 2 (#753): awaited, not fired off, so a pass can't
      // outlive its tick; run on the tick path too since the control arm
      // holds its own lots and is subject to the same flat-by-close
      await this.steps.controlArm?.({ signal, ctx });
      // Bar floored once here, onto the decision gate's own grid, so every
      // tick-pass flatten inside one bar re-keys to the same order (#743)
      return runExitCheckPass(floorToBar(clock.now(), DEBATE_BAR_TIMEFRAME_MS));
    }

    markStage('analysts');
    const analystsInput = { trace_id, signal, clock, bar: decisionBar.open_time };
    const analystsTimer = startStageTimer();
    const views = await this.steps.analysts(analystsInput);
    // Destructive read (#1080): a skip kind belongs to one pass, not a store to be queried later
    const analystsDecision =
      views.length === 0
        ? analystsSkipDecisionWord(this.steps.analystSkipKind?.(trace_id))
        : 'quorum_met';
    record('analysts', analystsDecision, analystsInput, views, analystsTimer);

    // Falsifier arm 2 (#753): sited after analysts, before debate, so the
    // control arm sees the SAME views on the SAME bar with debate bypassed,
    // rather than re-running analysts itself (which could trigger a live
    // model call the control arm must never make)
    await this.steps.controlArm?.({ signal, ctx, views });

    if (views.length === 0) {
      // A quorum skip has no Trader entry point to carry the flatten (#785), so it runs the exit check itself
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
    // NOT `debate.direction` (#1080): every degraded debate resolves to
    // `neutral`, which made a starved budget and a genuine wash the same word
    // in `audit_log` and on the dashboard. See `debateDecisionWord`.
    record('debate', debateDecisionWord(debate), debateInput, debate, debateTimer);

    // A bar mismatch means the intent may land on a coordinate another intent
    // already holds and gets suppressed as a duplicate — indistinguishable
    // from a healthy no-trade tick without this warning (#743)
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

    // Phase split (#1040): everything above is the portfolio-free head; below reads/mutates the book and waits for this instrument's turn
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

  /**
   * The reader for `RiskDecision.warnings` (#303), which previously had none.
   * Reports transitions rather than per-tick state — six instruments warning
   * every tick is ~8,640 lines/day, enough that an operator stops reading
   * warns and misses the fault that needed one (#362 fixed the same problem
   * at startup). Nothing is lost: `record('risk', ...)` already logs the
   * full warning set every tick; this only raises a CHANGE.
   */
  private reportAdvisoryWarnings(instrument: string, warnings: string[], ctx: TickContext): void {
    // Sorted since warning order shifts whenever a position closes/reopens; comparing raw order would re-fire on a reordering alone
    const signature = [...warnings].sort().join('|');
    if (this.#lastAdvisory.get(instrument) === signature) return;

    const hadWarnings = (this.#lastAdvisory.get(instrument) ?? '') !== '';
    if (warnings.length === 0 && !hadWarnings) return;
    this.#lastAdvisory.set(instrument, signature);

    // Clearing is good news — `info`, not `warn` — and still emitted so coverage completing is a positive log statement, not silence
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
