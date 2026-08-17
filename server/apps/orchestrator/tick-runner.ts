/**
 * Tick Runner (ticket #94, audit/log wiring #95, tick/decision split #743) —
 * see docs/specs/orchestrator-spec.md (Module: Tick Runner, Module:
 * Structured Logging & Audit Spine).
 *
 * Drives one instrument's pass, on one of two cadences:
 *
 *   tick pass (every tick, τ = 2 min): the position-facing exit check — the
 *     Trader's exit-only entry point (positions, mark, flatten window), then
 *     Risk -> Verdict -> Execution if it produced an exit intent. No
 *     analysts, no debate: the exit path is reachable without either, by
 *     construction (`TickSteps.exitCheck`'s input carries neither).
 *
 *   decision pass (ctx.decision_bar set — once per debate bar): Analysts ->
 *     Debate -> Trader -> Risk -> Verdict -> (on `go`) Execution. A
 *     straight-line sequential chain over the already-specced stage
 *     contracts — no stage decision logic lives here.
 *
 * Exactly ONE Trader entry point runs per pass. A decision pass does not also
 * run the tick path's exit check, because the Trader's own routing evaluates
 * the flatten window FIRST on its holding branch (`decide.ts`, #668) — so the
 * flatten is evaluated on every pass through whichever entry point the pass
 * runs, and running both would emit the same-keyed exit twice and write two
 * audit rows per tail stage in one trace. The one pass this can cost a
 * flatten on is a decision pass that short-circuits before Trader (a quorum
 * skip); the next tick, two minutes later, is a tick pass and fires it.
 * Before the split, a quorum skip lost the flatten for a full tick interval
 * in exactly the same way — this is not a new exposure, and it is now bounded
 * by τ rather than by the old everything-is-a-decision cadence.
 *
 * Short-circuit exits, each returning the stage that ended the pass:
 *   position_check — null exit intent (the common case: ~29 of 30 passes)
 *   analysts — empty view set (quorum skip, analysts-spec.md story 21)
 *   trader   — null intent (no-trade; `Trader.decide` is `OrderIntent | null`)
 *   risk     — `rejected`
 *   verdict  — `no_go`
 * Execution is unreachable from all of these, which is the gate-vs-actor
 * separation (orchestrator-spec.md story 7) this ticket must guarantee.
 *
 * The bar coordinate (#687/#743): on a decision pass, `ctx.decision_bar` is
 * the single source — the Debate step keys `debate_id` on it and the Trader
 * inherits it via `DebateResult.bar_timestamp`. The runner ASSERTS the
 * inheritance: a `DebateResult` whose `bar_timestamp` disagrees with the
 * gate's bar logs a loud `decision bar divergence` warning, because the
 * failure mode of that disagreement is a suppressed entry — an intent keyed
 * to a bar another intent already took — which otherwise presents as a
 * healthy no-trade tick. On a tick pass the runner floors the clock once and
 * hands the result to the exit check; no stage below derives a bar of its
 * own.
 *
 * Every stage actually reached emits exactly one `logger.log` line and one
 * `auditLog.record` row, both carrying `trace_id` — a short-circuited stage
 * and everything after it produce no row (there is no decision to record).
 * One exception, added by #303: when a `RiskDecision`'s advisory `warnings`
 * CHANGE for an instrument, a second line is emitted for the risk stage —
 * `warn` while warnings stand, `info` when they clear, always with
 * `payload.advisory: true`. It adds no audit row (the decision is already
 * recorded) and never alters control flow. See `reportAdvisoryWarnings` for
 * why it reports transitions rather than repeating state every tick.
 *
 * The `current_tick` progress row the spec attaches to this module (#96):
 * upserted before each stage call, deleted on every normal terminal return.
 * Deliberately not wrapped in try/finally — a thrown error (crash mid-tick)
 * must leave the row stale rather than clean it up, since the acceptance
 * criterion is that a stale row is safely overwritten next tick, not that a
 * crash is invisible.
 */
import type { Signal } from '../../pipeline/analysts/index.js';
import { DEBATE_BAR_TIMEFRAME_MS, floorToBar } from '../../pipeline/debate-engine/index.js';
import type { OrderIntent } from '../../shared/index.js';
import { digest } from './digest.js';
import type { TickContext, TickOutcome, TickRunner, TickStage, TickSteps } from './types.js';

export class SequentialTickRunner implements TickRunner {
  /**
   * Last advisory-warning set emitted per instrument, so the advisory line
   * marks a CHANGE rather than repeating a state (#303, on review).
   *
   * Deliberately in-memory and not persisted: a restart re-announcing the
   * current advisory state once is the desirable behaviour, not a bug — the
   * operator reading a fresh log gets the standing state without having to
   * query the store.
   */
  readonly #lastAdvisory = new Map<string, string>();

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
        // Migration 0013. Both were always in scope here and simply never
        // persisted, which left every short-circuited tick unattributable to
        // an instrument — `current_tick` covers only the in-flight tick and
        // `verdict_log` only the ticks that reached Verdict, so a tick that
        // stopped at Analysts or Risk belonged to nothing readable.
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
     * The shared Risk -> Verdict -> Execution tail. Both paths converge here
     * once a Trader entry point produced an intent, so the gate-vs-actor
     * separation (Execution only on a Verdict `go`) is enforced in exactly
     * one place. `extras` lets the tick path stamp `flatten_fired` or
     * `early_exit_fired` onto whichever terminal outcome the tail reaches.
     */
    const runIntentTail = async (
      intent: OrderIntent,
      extras: Pick<TickOutcome, 'early_exit_fired' | 'flatten_fired'>,
    ): Promise<TickOutcome> => {
      markStage('risk');
      const riskInput = { trace_id, intent, clock };
      const riskDecision = await this.steps.risk(riskInput);
      record('risk', riskDecision.status, riskInput, riskDecision);
      this.reportAdvisoryWarnings(instrument, riskDecision.warnings, ctx);
      if (riskDecision.status === 'rejected') {
        currentTickStore.delete(instrument);
        return { trace_id, final_stage: 'risk', ...extras };
      }

      markStage('verdict');
      const verdictInput = { trace_id, risk_decision: riskDecision, clock };
      const verdict = await this.steps.verdict(verdictInput);
      record('verdict', verdict.status, verdictInput, verdict);
      if (verdict.status !== 'go') {
        currentTickStore.delete(instrument);
        return { trace_id, final_stage: 'verdict', verdict_status: 'no_go', ...extras };
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
        ...extras,
      };
    };

    const decisionBar = ctx.decision_bar;
    if (decisionBar === undefined) {
      // ── TICK PASS (#743): the cheap, position-facing path. ────────────────
      // No analysts, no debate — the exit check's input carries neither, so an
      // exit CANNOT read analyst output (constraint 4 of the split). The bar
      // is floored HERE, once, onto the same grid the decision gate uses; the
      // exit intent's idempotency key dedupes on it, so every tick-pass
      // flatten inside one bar re-keys to the same order.
      markStage('position_check');
      const bar = floorToBar(clock.now(), DEBATE_BAR_TIMEFRAME_MS);
      const exitInput = { trace_id, instrument, bar, clock };
      const exitIntent = await this.steps.exitCheck(exitInput);
      // #748: the tick path can now fire TWO kinds of exit, so the audit row
      // names which — `flatten` and `signal_decay` are different events with
      // different causes, and one shared `'flatten'` string would make an
      // early release read as a session ending four hours early.
      record(
        'position_check',
        exitIntent === null ? 'no_exit_due' : (exitIntent.metadata.exit_reason ?? 'exit'),
        exitInput,
        exitIntent,
      );
      if (exitIntent === null) {
        currentTickStore.delete(instrument);
        return { trace_id, final_stage: 'position_check' };
      }
      // Separate flags rather than one `exit_fired`, for the reason
      // `flatten_fired` exists at all: a rejected flatten and a rejected early
      // release are both invisible without a flag, and folding them together
      // would lose exactly the distinction the flag was added to preserve.
      return runIntentTail(
        exitIntent,
        exitIntent.metadata.exit_reason === 'signal_decay'
          ? { early_exit_fired: true }
          : { flatten_fired: true },
      );
    }

    // ── DECISION PASS: the full chain, once per debate bar. ─────────────────
    markStage('analysts');
    const analystsInput = { trace_id, signal, clock };
    const views = await this.steps.analysts(analystsInput);
    record('analysts', views.length === 0 ? 'quorum_skip' : 'quorum_met', analystsInput, views);
    if (views.length === 0) {
      currentTickStore.delete(instrument);
      return { trace_id, final_stage: 'analysts' };
    }

    markStage('debate');
    // `asset_class` comes straight off the `Signal` the scheduler produced
    // (#388): the Debate Engine's rate-limit budget and latency budget are
    // both keyed on it, and this is the only layer that holds it as fact.
    // `bar` is the gate's — the single derivation for this pass (#687/#743).
    const debateInput = {
      trace_id,
      instrument,
      asset_class: signal.asset_class,
      views,
      clock,
      bar: decisionBar.open_time,
    };
    const debate = await this.steps.debate(debateInput);
    record('debate', debate.direction, debateInput, debate);

    // BAR-IDENTITY ASSERTION (#743, acceptance: a suppressed entry must be
    // observable). The Trader keys its intent on `debate.bar_timestamp`; if
    // that ever disagrees with the gate's bar, the intent lands on a bar
    // coordinate another intent may already hold and is suppressed downstream
    // as a duplicate — which, without this line, reads exactly like a healthy
    // no-trade tick. The pass still proceeds: Verdict's staleness gate is the
    // fail-safe refusal, this is the audible record that it happened.
    if (debate.bar_timestamp.getTime() !== decisionBar.open_time.getTime()) {
      logger.log({
        trace_id,
        stage: 'debate',
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

    markStage('trader');
    const traderInput = { trace_id, instrument, debate, clock };
    const intent = await this.steps.trader(traderInput);
    record('trader', intent === null ? 'no_trade' : intent.intent_type, traderInput, intent);
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
    // Sorted copy: the signature compares SETS, not sequences.
    // `insufficient_history` follows `Object.keys(exposure_by_instrument)`,
    // whose insertion order follows `getOpenPositions()`'s `ORDER BY
    // opened_at` — no tiebreak, and the order shifts whenever a position
    // closes and reopens. Comparing raw order would read a reordering as a
    // change and re-fire, defeating the suppression this method exists for.
    // The payload keeps the original order; only the comparison is sorted.
    const signature = [...warnings].sort().join('|');
    if (this.#lastAdvisory.get(instrument) === signature) return;

    const hadWarnings = (this.#lastAdvisory.get(instrument) ?? '') !== '';
    if (warnings.length === 0 && !hadWarnings) return;
    this.#lastAdvisory.set(instrument, signature);

    // Clearing is good news and must never page — `info`, not `warn`. It is
    // emitted at all so that coverage completing is a positive statement in
    // the log, not an absence indistinguishable from this reader breaking.
    //
    // `instrument` is carried explicitly because a `correlation_warmup:MSFT`
    // tag names one side of a PAIR, and the unmeasurable side may be this
    // tick's own instrument (see `CorrelationEstimate.insufficient_history`).
    ctx.logger.log({
      trace_id: ctx.trace_id,
      stage: 'risk',
      level: warnings.length > 0 ? 'warn' : 'info',
      message:
        warnings.length > 0
          ? `risk: ${instrument} — advisory warnings: ${warnings.join(', ')}`
          : `risk: ${instrument} — advisory warnings cleared`,
      payload: { instrument, warnings, advisory: true },
    });
  }
}
