/**
 * Falsifier arm 2, wired to run in parallel with the live arm on every tick
 * (#753) — see ADR-0014 amendment 2, ADR-0017 §Consequences, and
 * `docs/research/12-edge-hypothesis-critique.md` D4.
 *
 * ## The shape of the thing
 *
 * The control arm is **the live arm's own tick runner, over the live arm's own
 * stage implementations, with exactly one step replaced**: the Debate step
 * becomes `controlArmDecision` — the technical analyst's deterministic axis
 * vote, in `DebateResult` shape, computed with no model call. Everything else
 * is the same code: the same `SequentialTickRunner` sequencing, the same
 * short-circuits, the same `Trader.decide` with the same `TraderConfig`
 * conviction floor and the same frozen ADR-0018 D3 bracket and stop, the same
 * `checkExits` exit rule, the same Risk gates, the same Verdict, the same
 * `ExecutionImpl`.
 *
 * That is not an optimisation. #753's acceptance criteria require the two arms
 * to share the same name list, the same exit rule and the same stop *asserted,
 * not configured twice*, and the only way to assert that rather than maintain it
 * is for there to be one implementation with one config. `analysts-spec.md`
 * states the property this preserves: the control "IS the live arm minus one
 * stage, rather than a reimplementation that has to be kept in sync."
 *
 * ## What is NOT shared, and why each one has to be separate
 *
 * The arms share a **tape**. They must not share a **book**. Four things are
 * therefore per-arm, and each of them is a way the control would otherwise
 * corrupt the live arm rather than measure it:
 *
 * 1. **The store** (`SqliteExecutionStore` constructed with `arm: 'control'`).
 *    Its two scan queries filter on the arm, so control lots never enter the
 *    live arm's `computePortfolioView`, its exposure caps or its D5 envelope.
 *    A shared store would have the two arms consuming each other's headroom —
 *    each vetoing trades the other's presence made unaffordable — which is a
 *    contaminated comparison, not a control.
 * 2. **The broker** (`SimulatedBrokerAdapter`). The book is £1,000 and ADR-0018
 *    D5 deploys 35%/25% of it per position; a second arm placing real orders at
 *    the same envelope doubles deployment, which no ADR authorises and which
 *    would breach the drawdown envelope #925/#932 gate the live ramp on. The
 *    mandate is a MEASUREMENT, not a second book. The simulated adapter prices
 *    its fills through the same `CostModel` the backtest uses, so the control's
 *    returns are cost-inclusive — a zero-cost control would flatter the
 *    indicator arm against ADR-0018 D3's round-trip bar and invalidate the very
 *    comparison this exists for.
 * 3. **The circuit breakers and their persistence.** `evaluate()` persists the
 *    sticky tiers, so a shared instance would let a control-arm drawdown trip a
 *    breaker that halts the live book. The control's breaker state is
 *    in-memory: it is real enough to gate the control's own trading (the arms
 *    must be matched on refusals too) and deliberately not durable, because a
 *    measurement's breaker latch is not something a restart must preserve.
 * 4. **The `current_tick` progress row.** `CurrentTickStore` keys on instrument
 *    and overwrites, so a control pass writing it would clobber the live pass's
 *    progress. The control arm gets an in-memory one.
 *
 * ## The no-LLM guarantee
 *
 * The control arm's step set contains no debate step, no LLM client and no
 * market-intelligence agent. Its `analysts` step is a RELAY — it returns the
 * views the live arm's analysts step already produced for this pass — and that
 * matters for more than cost: re-running the analysts step would re-enter
 * `MarketIntelligenceStore.getContext`, which can call the Nous/Grok ingest
 * agent. A control arm that re-ran its analysts would therefore violate "no LLM
 * anywhere in the path" *in production* while every unit test with a stubbed
 * analysts step stayed green. Relaying is also what makes "the same name list,
 * over the same tape, from the same start" literally true: the two arms decide
 * from the same `AnalystView` objects, on the same bar.
 *
 * ## Containment
 *
 * `SequentialTickRunner.runInstrument` deliberately has no try/catch — a crash
 * must leave the `current_tick` row stale for the next tick to clobber. So the
 * containment for the control arm lives HERE, at its one call site, and not in
 * the runner: a failure in the measurement must never take down the arm that
 * trades the book. It is logged at `warn`, because a control arm that has
 * silently stopped producing decisions is a control arm that cannot answer the
 * question at the end of the soak.
 */

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

// Re-exported from its definition in `pipeline/control-arm`, where it sits
// beside the debate-id prefix: this module applies it, but the readers that
// exclude the control arm must not import the orchestrator to get it
export { CONTROL_TRACE_SUFFIX };

/**
 * The live pass's `AnalystView[]`, handed to the control arm's `analysts` step.
 *
 * A relay rather than a re-run, for the reason this module's header gives: the
 * real analysts step can reach an LLM-backed market-intelligence agent, and it
 * would also read the tape a second time at a second instant. One pass, one view
 * set, both arms.
 *
 * Keyed by the CONTROL trace id (the live trace plus `:control`) and cleared by
 * the caller in a `finally`, so a crashed control pass cannot leave a view set
 * behind for a later pass to decide from.
 */
export class AnalystViewRelay {
  readonly #views = new Map<string, readonly AnalystView[]>();

  set(trace_id: string, views: readonly AnalystView[]): void {
    this.#views.set(trace_id, views);
  }

  clear(trace_id: string): void {
    this.#views.delete(trace_id);
  }

  /**
   * The views for this pass, or `[]` when none were relayed.
   *
   * `[]` is the honest answer and the useful one: the tick runner reads an empty
   * view set as a quorum skip and falls through to the exit check, which is
   * exactly what a control pass with nothing to decide from should do — evaluate
   * its flat-by-close and its held-position exits, and open nothing.
   */
  get(trace_id: string): AnalystView[] {
    return [...(this.#views.get(trace_id) ?? [])];
  }
}

/**
 * The control arm's `analysts` step: the relay, not the analyst layer.
 *
 * Typed as `TickSteps['analysts']` so it cannot drift from the shape the runner
 * calls, and deliberately ignoring every input but the trace id — there is
 * nothing for it to compute.
 */
export function buildControlAnalystsStep(relay: AnalystViewRelay): TickSteps['analysts'] {
  return async ({ trace_id }) => relay.get(trace_id);
}

/**
 * The control arm's `debate` step — the ONE step that differs from the live arm.
 *
 * It is `async` only because the interface is: there is no await inside it, no
 * client, and no I/O. `controlArmDecision` is a pure function of the relayed
 * views.
 *
 * A `null` decision (no technical view in the set at all) becomes a NEUTRAL
 * result rather than a throw or a special case. The Trader already declines a
 * neutral direction, on the same branch and with the same `trader_log` skip
 * reason it uses for the live arm — so the absence of an axis vote costs the
 * control arm a trade in exactly the way it should, without a second entry gate
 * existing anywhere in the control's path.
 */
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
      // `true` here for the same reason `controlArmDecision` gives, and it costs
      // the control nothing on this branch: a neutral direction is declined by
      // the Trader before `converged` is read at all
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
      // Genuine falsifier decline despite the synthesis text above ("had
      // nothing to read"): no LLM ran, but this is already the CURRENT
      // `declined_on_signal` baseline via `neutral_direction_while_flat`
      // `read: false` would flip that classification to `could_not_decide`
      // — see DebateResult.read's docblock for why this path sets `true`
      read: true,
    };
  };
}

/**
 * The control arm's `current_tick` writer.
 *
 * In-memory and per-arm because `current_tick` holds ONE row per instrument and
 * `upsert` overwrites it: a control pass writing to the live table would clobber
 * the live pass's progress indicator for the same instrument on the same tick,
 * making a healthy live decision pass read as stalled at whatever stage the
 * control happened to reach last.
 *
 * Nothing is lost by not persisting it. `current_tick` is documented as
 * disposable and not a system of record (orchestrator-spec.md story 15); losing
 * it costs a stale progress indicator, and the control arm has no operator-facing
 * progress indicator to be stale.
 */
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
  /**
   * A `SequentialTickRunner` over the CONTROL step set — the same class the
   * live arm runs, so the sequencing, the short-circuits and the Risk →
   * Verdict → Execution tail are literally shared rather than re-implemented
   */
  runner: TickRunner;
  /** The relay the control `analysts` step reads this pass's views from */
  relay: AnalystViewRelay;
  /** The control arm's own `current_tick` writer — never the live one */
  currentTickStore: CurrentTickStore;
  /** Where a control-arm failure is reported. The live tick continues regardless. */
  logger: Logger;
}

/**
 * The hook the live tick runner calls, once per instrument per tick.
 *
 * Called on EVERY tick, not only on decision bars, and that is the ordering
 * constraint #753 states in as many words: *run it in parallel with the soak
 * from the first day, not retrofitted later*. Two consequences follow from
 * "every tick" that are easy to lose:
 *
 * - On a **decision pass** the control arm decides from the same views on the
 *   same bar, so the two arms' entries are comparable trade for trade.
 * - On a **tick pass** the control arm runs its own position-facing exit check.
 *   Without that its lots would never reach ADR-0014's mandatory flat-by-close,
 *   and the control would be measuring an overnight-carry strategy the live arm
 *   is forbidden from running — which is not a matched control at all.
 */
export type ControlArmStep = (input: {
  signal: Signal;
  /** The live pass's context — the source of the trace, the clock and the bar */
  ctx: TickContext;
  /**
   * The live pass's analyst views. Present on a decision pass that ran the
   * analysts step (even when it returned none); absent on a tick pass, where the
   * control arm has an exit check to run and nothing to decide.
   */
  views?: readonly AnalystView[];
}) => Promise<void>;

export function buildControlArmStep(deps: ControlArmDeps): ControlArmStep {
  return async ({ signal, ctx, views }) => {
    const trace_id = `${ctx.trace_id}${CONTROL_TRACE_SUFFIX}`;
    if (views !== undefined) deps.relay.set(trace_id, views);

    try {
      await deps.runner.runInstrument(signal, {
        clock: ctx.clock,
        // Suffixed rather than fresh: the control pass and the live pass it
        // shadows must be joinable in `audit_log` and the decision records, and
        // a wholly separate id would make the pairing unrecoverable. The suffix
        // is also what keeps the two arms' rows separable in tables that have no
        // `arm` column of their own
        trace_id,
        logger: ctx.logger,
        auditLog: ctx.auditLog,
        currentTickStore: deps.currentTickStore,
        // Present exactly when the live pass is a decision pass, so the control
        // arm takes the decision path on the same bars the live arm does and the
        // tick path on the same ticks. Conditional spread under
        // `exactOptionalPropertyTypes`
        ...(ctx.decision_bar === undefined ? {} : { decision_bar: ctx.decision_bar }),
        // `beginPortfolioTail` is DELIBERATELY not forwarded (#1040). The
        // turnstile orders passes that mutate the LIVE book; the control arm
        // writes to its own shadow book and mutates nothing the live arm reads,
        // so it needs no turn — and taking one would make the live pass hold
        // the serial section open across the control pass's whole chain, which
        // is measurement latency charged to the arm that trades
      });
    } catch (error) {
      // The measurement must never take down the arm that trades the book. See
      // the module header: this catch is here and not in the runner because the
      // runner's lack of one is a deliberate, documented invariant
      deps.logger.log({
        trace_id,
        stage: 'control_arm',
        event: 'control_arm_pass_failed',
        // #1089: 'error', not 'warn' — a contained crash from ANY cause (not
        // only the whole-book valuation refusal that Trader now converts to a
        // named skip before it ever reaches here) must surface above the
        // level an unattended soak's operator actually reads
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
