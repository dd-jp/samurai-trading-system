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
import type { Signal } from '../analysts/index.js';
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
    // `asset_class` comes straight off the `Signal` the scheduler produced
    // (#388): the Debate Engine's rate-limit budget and latency budget are
    // both keyed on it, and this is the only layer that holds it as fact.
    const debateInput = { trace_id, instrument, asset_class: signal.asset_class, views, clock };
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
    this.reportAdvisoryWarnings(instrument, riskDecision.warnings, ctx);
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
