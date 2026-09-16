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

  /** Publishes `trace_id` as ambient context so log sites with no channel to receive one (`TokenBucket`, `MarketDataService`) can still name the tick. */
  async runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome> {
    return runWithTraceId(ctx.trace_id, () => this.#runInstrument(signal, ctx));
  }

  async #runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome> {
    const { trace_id, clock, logger, auditLog, currentTickStore } = ctx;
    const instrument = signal.asset;

    // wallMs (real Date.now, not the backtest-steppable clock) for started_at;
    // perfMs (monotonic performance.now, immune to NTP step-back) for duration.
    // Named fields, not two positional numbers, since the two are trivially
    // transposable as bare `number` params.
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
      // quieted to `debug` rather than dropped.
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
        // verdict_log covered it.
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
     * is enforced in exactly one place.
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
      // are different events and must not share one audit string.
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
      // every instrument ahead of it in the plan for nothing.
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
      // ── FALSIFIER ARM 2, tick cadence (#753). ────────────────────────────
      // Awaited BEFORE the live exit check, and run on the tick path at all,
      // because the control arm holds its own lots and they are subject to the
      // same ADR-0014 flat-by-close the live arm's are. A control that only ran
      // on decision bars would carry positions overnight, which is not the live
      // arm minus one stage — it is a different strategy
      //
      // Awaited rather than fired off so a pass cannot outlive the tick that
      // started it and decide against the next bar's tape. It never rejects
      // (see `TickSteps.controlArm`), so there is nothing here to catch: the
      // containment is inside the step, where it does not disturb this method's
      // deliberate absence of a try/catch
      await this.steps.controlArm?.({ signal, ctx });
      // ── TICK PASS (#743): the cheap, position-facing path. ────────────────
      // The bar is floored HERE, once, onto the same grid the decision gate
      // uses; the exit intent's idempotency key dedupes on it, so every
      // tick-pass flatten inside one bar re-keys to the same order
      return runExitCheckPass(floorToBar(clock.now(), DEBATE_BAR_TIMEFRAME_MS));
    }

    // ── DECISION PASS: the full chain, once per debate bar. ─────────────────
    markStage('analysts');
    // `bar` is the gate's — the single derivation for this pass (#687/#743),
    // threaded to the analysts (and, through them, to
    // `MarketIntelligenceStore.getContext`) unchanged (#811) rather than
    // re-derived from `clock.now()` a second time
    const analystsInput = { trace_id, signal, clock, bar: decisionBar.open_time };
    const analystsTimer = startStageTimer();
    const views = await this.steps.analysts(analystsInput);
    // Read only on the empty branch, and destructively (#1080): a kind belongs
    // to one pass, and the relay is a side channel for the fact the step's
    // return type cannot carry, not a store to be queried later
    const analystsDecision =
      views.length === 0
        ? analystsSkipDecisionWord(this.steps.analystSkipKind?.(trace_id))
        : 'quorum_met';
    record('analysts', analystsDecision, analystsInput, views, analystsTimer);

    // ── FALSIFIER ARM 2, decision cadence (#753). ──────────────────────────
    // Sited HERE — after the analysts step, before the debate — because that is
    // the only point at which the control arm can be what the mandate says it
    // is: the SAME name selection over the SAME views on the SAME bar, with the
    // debate stage bypassed. Handing it `views` rather than letting it re-run
    // the analysts step is load-bearing for the no-LLM guarantee as well as for
    // the shared tape: `buildAnalystsStep` reaches
    // `MarketIntelligenceStore.getContext`, which can call the Nous/Grok ingest
    // agent, so a control arm that re-ran its analysts would make a model call
    // in production while every stubbed-step unit test stayed green
    //
    // Passed even when `views` is empty: the control arm reads an empty set the
    // same way this runner does — a quorum skip that falls through to its own
    // exit check — so a quorum-skipped bar still evaluates the control's
    // flat-by-close instead of silently skipping it
    await this.steps.controlArm?.({ signal, ctx, views });

    if (views.length === 0) {
      // A quorum skip has no Trader entry point of its own to carry the
      // flatten (#785) — so this pass still evaluates it, through the exact
      // same exit check the tick path uses. `decisionBar.open_time` is the
      // gate's OWN bar (the single derivation for a decision pass, #687/#743)
      // rather than a fresh `floorToBar(clock.now(), ...)` — the gate has
      // already done this derivation for this pass, and a second one could
      // only disagree with it, never improve on it
      return runExitCheckPass(decisionBar.open_time);
    }

    markStage('debate');
    // `asset_class` comes straight off the `Signal` the scheduler produced
    // (#388): the Debate Engine's rate-limit budget and latency budget are
    // both keyed on it, and this is the only layer that holds it as fact
    // `bar` is the gate's — the single derivation for this pass (#687/#743)
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
    // from a healthy no-trade tick without this warning (#743).
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

    // Phase split (#1040): everything above is the portfolio-free head; below reads/mutates the book and waits for this instrument's turn.
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
   * The reader for `RiskDecision.warnings` (#303) — which had no production
   * reader at all before this, CII's `macro_risk_flag` (#205) included: the
   * tags rode along inside the risk stage's `info` payload and nothing ever
   * raised them.
   *
   * ## Why this reports transitions, not state
   *
   * `DEFAULT_TICK_INTERVAL_MS` is 60s. Six instruments warning every tick is
   * ~8,640 `warn` lines a day, and with `min_bars: 20` on a `1d` timeframe the
   * correlation warm-up does not clear inside a 14-day soak (#238) — so a
   * per-tick warn would BE the soak's log. The cost is not disk: an operator
   * who scrolls past thousands of identical warns stops reading warns, and
   * then misses the stuck unpriced fill or the kill-threshold breach that
   * needed them. #362 fixed exactly this at startup; reintroducing it here at
   * 8,640x/day would be worse.
   *
   * Nothing is lost by going quiet, because the state is already logged every
   * tick: `record('risk', ...)` writes the whole `RiskDecision`, `warnings`
   * included, to its `info` payload. This line's only job is to RAISE a
   * change; the per-tick record remains the answer to "what is true now".
   *
   * A pure once-per-process latch (the shape `production.ts` uses for the
   * inert-divergence warn) would be wrong here: that warn describes a frozen
   * config, whereas this describes a transient state whose CONTENTS matter. If
   * ETH-USD gains coverage while BTC-USD has not, an operator needs to see it,
   * so the key is the warning set itself, per instrument.
   *
   * `advisory: true` rides on every line this emits. Level alone cannot carry
   * the distinction: a generic pipeline paging on `level:warn` has no other
   * way to tell an advisory from a real fault, and the spec's `SAMURAI_ALERTS`
   * reasoning does not reach such a pipeline.
   */
  private reportAdvisoryWarnings(instrument: string, warnings: string[], ctx: TickContext): void {
    // Sorted copy: the signature compares SETS, not sequences
    // `insufficient_history` follows `Object.keys(exposure_by_instrument)`,
    // whose insertion order follows `getOpenPositions()`'s `ORDER BY
    // opened_at` — no tiebreak, and the order shifts whenever a position
    // closes and reopens. Comparing raw order would read a reordering as a
    // change and re-fire, defeating the suppression this method exists for
    // The payload keeps the original order; only the comparison is sorted
    const signature = [...warnings].sort().join('|');
    if (this.#lastAdvisory.get(instrument) === signature) return;

    const hadWarnings = (this.#lastAdvisory.get(instrument) ?? '') !== '';
    if (warnings.length === 0 && !hadWarnings) return;
    this.#lastAdvisory.set(instrument, signature);

    // Clearing is good news and must never page — `info`, not `warn`. It is
    // emitted at all so that coverage completing is a positive statement in
    // the log, not an absence indistinguishable from this reader breaking
    //
    // `instrument` is carried explicitly because a `correlation_warmup:MSFT`
    // tag names one side of a PAIR, and the unmeasurable side may be this
    // tick's own instrument (see `CorrelationEstimate.insufficient_history`)
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
