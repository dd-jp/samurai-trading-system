/**
 * Production Composition Root: Debate adapter (ticket #235). See ADR-0004
 * §3, docs/specs/orchestrator-spec.md ("Module: Production Composition
 * Root"), closed wayfinder map #224.
 *
 * `runDebate(input, personas)` takes two arguments; `TickSteps.debate` takes
 * one object. This module also had to bridge a real gap discovered while
 * implementing it, undocumented by the ticket or ADR-0004: no production
 * code anywhere implements `DebaterPersona`/`MediatorPersona`
 * (round-orchestrator.ts's ports) over `runBullPersona`/`runBearPersona`/
 * `runMediatorPersona` (personas.ts) — only round-orchestrator.test.ts's
 * fakes do. `buildDebatePersonas` is that bridge, resolved as follows (see
 * PR body for the full writeup):
 *
 * - `stances` (per-analyst stance this round): personas.ts never re-polls
 *   individual analysts per round, so each analyst's stance for the round
 *   is its own upstream `AnalystView.direction` — exactly what
 *   round-orchestrator.test.ts's fake mediator does
 *   (`context.views.map(v => ({ analyst_id: v.analyst_id, stance: v.direction }))`).
 * - `confidence`: `computeConvictionScore(views, roundStances)` — a real,
 *   existing function. `roundStances` (cumulative across rounds) is
 *   accumulated in this closure the same way `runDebate` accumulates its
 *   own copy internally, since `RoundContext` doesn't expose one.
 * - `disagreement_summary`/`open_items`: `detectDisagreements(views,
 *   llmClient)` — a real, existing function — mapped `summary` ->
 *   `disagreement_summary`, `conflicts.map(c => c.nature)` -> `open_items`.
 *   Only called on the round the mediator converges, or the hard-cap round
 *   (`round === MAX_ROUNDS`): debate-engine-spec.md is explicit that
 *   disagreement detection "runs once per debate (not per round), so the
 *   LLM cost is bounded" — `runDebate` only ever keeps the *last*
 *   assessment's synthesis, so a cheap placeholder on intermediate,
 *   non-final rounds costs nothing observable.
 * - `direction` = the mediator's own `stance`; `synthesis` (free text) =
 *   the mediator's own `rationale`. One-line, defensible mappings.
 * - `position` ("actionable recommendation", per debate-engine-spec.md):
 *   genuinely not derivable from anything personas.ts/conviction-score.ts/
 *   disagreement-detector.ts return — no persona produces a position
 *   statement distinct from its rationale. Not load-bearing downstream:
 *   `Trader.decide()` reads only `debate.direction` and `debate.confidence`
 *   (trader/decide.ts), never `.position`. Templated from `direction` +
 *   `rationale` rather than left blank; flagged in the PR as the one actual
 *   invention, not silently assumed correct.
 *
 * **This module is also the `debate_log` writer (#364).** `SqliteDebateLogStore`
 * was constructed in `production.ts` and called by nothing, so a live paper run
 * of fully converged debates left the table at zero rows and
 * `feedback-loop/attribution.ts` with no input at all. The write belongs here
 * rather than in `tick-runner.ts` because this is the only place that holds
 * BOTH the resolved `DebateResult` and the exact `bar` that went into its
 * `debate_id` hash — the tick runner would have to call `clock.now()` a second
 * time and would stamp the row with a bar the id does not encode. See
 * `persistDebateLog` for what is written when a debate does not converge, and
 * what is deliberately not written when one fails partway.
 */
import type {
  AnalystRoundStance,
  AnalystView,
  DebateResult,
  LlmClient,
  SpendCap,
} from '../../debate-engine/index.js';
import {
  applyAnalystWeights,
  buildAnalystContributions,
  buildDebateLog,
  computeConvictionScore,
  computeDebateId,
  type DebatePersonas,
  type DebaterPersona,
  detectDisagreements,
  enforceLatencyBudget,
  floorToBar,
  JsonDebateLogger,
  MAX_ROUNDS,
  type MediatorAssessment,
  type MediatorPersona,
  type PartialDebateState,
  type PersonaResponse,
  type RateLimiter,
  type RoundContext,
  type RoundStance,
  runBearPersona,
  runBullPersona,
  runDebate,
  runMediatorPersona,
} from '../../debate-engine/index.js';
import {
  type Clock,
  type DebateLogStore,
  type Logger,
  sanitizeLogText,
} from '../../shared/index.js';
import type { TickSteps } from '../types.js';

/** The one method the debate step needs from the tuning store (#435). */
export interface AnalystWeightSource {
  getAnalystWeights(): Record<string, number>;
}

import { RateLimitedLlmClient } from './rate-limited-llm-client.js';

/**
 * The persona set plus the debate's synthesis-in-progress (#374).
 *
 * `enforceLatencyBudget` needs a `getCurrentState` to build the partial
 * synthesis its timeout path returns, and `runDebate` deliberately does not
 * expose round state — the ephemeral debate is "no transcript, no
 * persistence" (debate-engine-spec.md). The mediator closure below is
 * nonetheless the one place that HAS that state: it already accumulates
 * `accumulatedStances` and sees every round's synthesis. So the state is read
 * off the closure rather than plumbed out of the orchestrator, which keeps
 * `runDebate`'s contract unchanged.
 *
 * Extends `DebatePersonas` rather than wrapping it so existing callers can
 * keep passing the result straight to `runDebate`.
 */
export interface DebatePersonasWithState extends DebatePersonas {
  /**
   * The last COMPLETED round's synthesis, or `undefined` if the budget fired
   * before any round finished (`enforceLatencyBudget` then uses its
   * low-confidence fallback). A round in flight has no assessment to report,
   * which is why this is written at the end of `mediator.assess` and not at
   * its start.
   */
  getCurrentState: () => PartialDebateState | undefined;
}

/**
 * Builds one debate's bull/bear/mediator port set over a shared LLM client.
 * Stateful per debate (not reusable across debates): the mediator closure
 * remembers the current round's bull/bear responses and the debate's
 * cumulative stances, which is safe only because round-orchestrator.ts
 * always calls bull.argue -> bear.argue -> mediator.assess in that order,
 * once per round, on one `runDebate` call.
 */
export function buildDebatePersonas(
  llmClient: LlmClient,
  trace_id: string,
  clock: Clock,
  /**
   * The debate every LLM call made through these personas is billed to (#326).
   * Computed by the caller BEFORE the debate runs — `computeDebateId` is a
   * pure hash of (instrument, bar, views), all three of which
   * `buildDebateStep` already holds — so the spend rows carry the same id the
   * `debate_log` row will, and a per-decision cost is a plain join.
   *
   * Optional so that the existing tests constructing personas without one keep
   * working; those calls simply meter as unattributed.
   */
  debate_id?: string,
): DebatePersonasWithState {
  let lastBull: PersonaResponse | undefined;
  let lastBear: PersonaResponse | undefined;
  const accumulatedStances: AnalystRoundStance[] = [];
  let currentState: PartialDebateState | undefined;

  const bull: DebaterPersona = {
    async argue(context) {
      const response = await runBullPersona(llmClient, {
        trace_id,
        debate_id,
        analyst_views: context.views,
        signal: context.signal,
      });
      lastBull = response;
      return { persona: 'bull', round: context.round, argument: response.rationale };
    },
  };

  const bear: DebaterPersona = {
    async argue(context) {
      const response = await runBearPersona(llmClient, {
        trace_id,
        debate_id,
        analyst_views: context.views,
        signal: context.signal,
      });
      lastBear = response;
      return { persona: 'bear', round: context.round, argument: response.rationale };
    },
  };

  const mediator: MediatorPersona = {
    async assess(context: RoundContext): Promise<MediatorAssessment> {
      if (lastBull === undefined || lastBear === undefined) {
        throw new Error(
          'debate-adapter: mediator.assess called before both bull and bear argued this round',
        );
      }

      const response = await runMediatorPersona(llmClient, {
        trace_id,
        debate_id,
        analyst_views: context.views,
        bullResponse: lastBull,
        bearResponse: lastBear,
        signal: context.signal,
      });

      const stances: RoundStance[] = context.views.map((view) => ({
        analyst_id: view.analyst_id,
        stance: view.direction,
      }));
      for (const stance of stances) {
        accumulatedStances.push({
          analyst_id: stance.analyst_id,
          round: context.round,
          stance: stance.stance,
        });
      }

      const isFinalRound = response.converged || context.round === MAX_ROUNDS;
      const disagreement = isFinalRound
        ? await detectDisagreements(context.views, llmClient, context.signal, {
            trace_id,
            debate_id,
          })
        : { summary: '', conflicts: [], method: 'directional_fallback' as const };

      const confidence = computeConvictionScore(context.views, accumulatedStances);

      // Recorded AFTER the round's LLM calls returned, so this is always a
      // completed round (#374). `debate_id` is required by
      // `PartialDebateState` and is what the timeout path stamps on its
      // result, so a persona set built without one (the pre-#326 test
      // callers) reports no state rather than inventing an id that would not
      // match the `debate_log` row.
      if (debate_id !== undefined) {
        currentState = {
          synthesis: response.rationale,
          position: `${response.stance}: ${response.rationale}`,
          confidence,
          contributions: buildAnalystContributions(context.views, accumulatedStances),
          disagreement_summary: disagreement.summary,
          // A partial state is non-converged by construction, and
          // `runDebate` holds the invariant that a non-converged result
          // carries non-empty `open_items` so Trader/Risk can apply caution.
          // Its own fallback — the disagreement summary — is empty on every
          // non-final round (`detectDisagreements` runs once per debate), so
          // falling back to it here would satisfy the invariant with an empty
          // string. This says what actually happened instead.
          open_items:
            disagreement.conflicts.length > 0
              ? disagreement.conflicts.map((conflict) => conflict.nature)
              : ['debate did not converge before the latency budget fired'],
          rounds_completed: context.round,
          direction: response.stance,
          debate_id,
        };
      }

      return {
        converged: response.converged,
        stances,
        synthesis: {
          synthesis: response.rationale,
          // Not derivable from any existing persona/analysis output — the
          // one genuine invention in this adapter (see file doc comment).
          // Not load-bearing: Trader reads only direction/confidence.
          position: `${response.stance}: ${response.rationale}`,
          confidence,
          direction: response.stance,
          disagreement_summary: disagreement.summary,
          open_items: disagreement.conflicts.map((conflict) => conflict.nature),
        },
      };
    },
  };

  return { bull, bear, mediator, clock, getCurrentState: () => currentState };
}

/**
 * Writes the one `debate_log` row this debate is entitled to (#364).
 *
 * WHEN A ROW IS WRITTEN — every debate that RESOLVES, converged or not.
 * `runDebate` returns a `DebateResult` on convergence AND on hard-cap
 * termination (`converged: false`, non-empty `open_items`), and both go down
 * this same path with no convergence branch: a debate that argued three
 * rounds and never agreed is at least as interesting to a post-soak
 * "why did it trade this?" as one that agreed immediately, and the Feedback
 * Loop attributes the trade either way. Same for a latency-budget
 * force-termination, if `enforceLatencyBudget` is ever wired in front of
 * `runDebate` — it also yields a resolved `DebateResult`.
 *
 * WHEN NO ROW IS WRITTEN — a debate that THROWS partway (an LLM transport
 * error, a persona that never answered). Deliberate, and not the silent drop
 * #364 is about: the failure is logged at `error` on the tick's own
 * `trace_id`, then rethrown. Two reasons a stub row would be worse than none:
 *
 *   1. There is no `DebateResult` to write. A stub would have to invent
 *      `direction`/`contributions`/`rounds` — and `contributions` is exactly
 *      what `feedback-loop/attribution.ts` reads. An empty array there is not
 *      "no data": `accumulateCredit` would iterate zero contributions and
 *      attribute the trade to nobody, which is indistinguishable from a real
 *      debate in which nobody took a stance.
 *   2. `debate_id` is a content hash of (instrument, bar, views) and
 *      `debate_log.debate_id` is the PK, so a stub PERMANENTLY occupies the
 *      key. debate-engine-spec.md ("State Persistence") says a crashed debate
 *      is re-run from scratch and "produces its one log entry on the eventual
 *      successful completion" — a stub written now would block that real row
 *      forever.
 *
 * IDEMPOTENCY — first-write-wins, checked before the insert. The tick loop can
 * retry, and a retry within the same bar recomputes the SAME `debate_id`, so a
 * second `writeLog` would hit the PK. `SqliteDebateLogStore.writeLog` raises on
 * a duplicate by design (it treats a repeat write as a bug), which would abort
 * the tick at the debate stage; and a duplicate row would double-count that
 * debate's analysts in attribution. So the duplicate is detected here and the
 * write skipped, at `warn` — the same first-write-wins posture as
 * `SqliteVerdictLogStore`'s `ON CONFLICT DO NOTHING` (#302), without weakening
 * the store's own contract for callers that genuinely should never collide.
 *
 * The read and the insert are separate statements rather than one atomic
 * upsert, and that is sound HERE for a reason worth stating: both are
 * synchronous `better-sqlite3` calls with no `await` between them, so no other
 * task can interleave in-process — the only interleaving that could defeat the
 * check is a SECOND PROCESS writing the same shared store, which the paper run
 * (#238) does not do. Should one ever exist, the loser gets
 * `SqliteDebateLogStore.writeLog`'s named duplicate error rather than this
 * quiet skip, which is the right way round: a cross-process collision on a
 * content-hash key is a real anomaly, not a retry.
 *
 * A write failure that is NOT a duplicate propagates: `debate_log` is the
 * Feedback Loop's system-of-record, and a store that cannot accept the row is
 * a broken store, so failing the tick before the Trader stage is the
 * fail-safe direction (no trade), and matches `auditLog.record`'s unguarded
 * call in `tick-runner.ts`.
 */
function persistDebateLog(params: {
  store: DebateLogStore;
  result: DebateResult;
  instrument: string;
  bar: Date;
  clock: Clock;
  trace_id: string;
  logger: Logger | undefined;
}): void {
  const { store, result, instrument, bar, clock, trace_id, logger } = params;

  if (store.getByDebateId(result.debate_id) !== undefined) {
    logger?.log({
      trace_id,
      stage: 'debate',
      level: 'warn',
      message:
        `debate: ${instrument} already has a debate_log row for debate_id ` +
        `${result.debate_id} — skipping the duplicate write (first write wins). ` +
        'Expected on a retried tick within the same bar; a repeat outside one means ' +
        'the same debate resolved twice.',
      payload: { instrument, debate_id: result.debate_id },
    });
    return;
  }

  // `trace_id` (#426): the tick that actually ran this debate. First-write-wins
  // is already this function's rule — the guard above returns before writing —
  // and that is exactly the semantics the column needs, since a retried tick
  // within the same bar carries a FRESH trace against the same content-hashed
  // `debate_id` and must not overwrite the attribution of the debate it did
  // not run.
  store.writeLog(buildDebateLog(result, instrument, bar, clock.now(), trace_id));
}

/**
 * The worst case `RateLimiter.reserve` is asked to cover for one debate, and
 * the number the paper profile's `maxLlmCalls` is sized in multiples of.
 *
 * DERIVED from the code, not chosen: `runDebate` runs at most `MAX_ROUNDS`
 * rounds, each issuing exactly the bull/bear/mediator triple built above, plus
 * the single `detectDisagreements` call the final round makes
 * (debate-engine-spec.md: disagreement detection "runs once per debate (not
 * per round), so the LLM cost is bounded"). Pinned against `MAX_ROUNDS` by a
 * test so a change to the round cap cannot silently under-reserve.
 */
export const LLM_CALLS_PER_ROUND = 3;
export const WORST_CASE_LLM_CALLS_PER_DEBATE = MAX_ROUNDS * LLM_CALLS_PER_ROUND + 1;

/**
 * What a debate the rate limiter refused to admit returns (#388).
 *
 * ## Why a result rather than a throw
 *
 * `SequentialTickRunner` does not catch a stage throw; it propagates out of
 * `runInstrument`. Before #507, that reached `runTickPlan`'s `Promise.all`
 * uncaught and settled the WHOLE tick early — one instrument's exhausted
 * budget would have discarded every other instrument's pass, the opposite of
 * what shedding load is for. `runTickPlan`'s worker now catches a throw
 * per-instrument (#507), so that specific danger is gone — but throwing here
 * would still log a routine, expected-under-load rate-limit refusal as an
 * `error`-level instrument failure, the wrong signal for a degrade-not-fail
 * path. Returning a resolved, deliberately unactionable result keeps this
 * instrument's outcome looking like what it is — a no-trade decision, not a
 * fault — and leaves the rest of the pass alone either way.
 *
 * ## Why it is safe to hand downstream
 *
 * `confidence: 0` is below any sane `conviction_floor` (`0.55` in
 * `DEFAULT_TRADER_CONFIG`), so `Trader.decide` returns `null` and the tick
 * short-circuits at `trader` with `no_trade` — the fail-safe direction, and
 * the same shape `enforceLatencyBudget`'s `LOW_CONFIDENCE_FALLBACK` already
 * hands back for a debate that ran out of time. `direction: 'neutral'` and the
 * explicit `open_items` entry mean the `audit_log` row names the cause rather
 * than looking like a debate that genuinely found nothing.
 *
 * ## Why NO `debate_log` row
 *
 * Same reasoning as a debate that throws partway (see `persistDebateLog`):
 * there is no debate to log. Writing one would permanently occupy the
 * content-hashed `debate_id` primary key — blocking the real row if the same
 * bar is retried once budget frees up — and would hand
 * `feedback-loop/attribution.ts` an empty `contributions` array, which
 * `accumulateCredit` cannot distinguish from a real debate in which no analyst
 * took a stance.
 */
export function rateLimitedDebateResult(debate_id: string, reason: string): DebateResult {
  return {
    synthesis: `Debate not started: ${reason}`,
    position: 'No position — the debate was not admitted under the LLM rate-limit budget.',
    confidence: 0,
    contributions: [],
    disagreement_summary: 'Debate not started; no disagreement was assessed.',
    open_items: [`debate not started: ${reason}`],
    converged: false,
    rounds_completed: 0,
    latency_ms: 0,
    direction: 'neutral',
    debate_id,
    rate_limited: { reason },
  };
}

/**
 * The same short-circuit shape as `rateLimitedDebateResult`, for a refusal on
 * COST rather than on rate. Kept separate rather than folded into one helper
 * with a parameterised string: the two refusals mean different things to
 * whoever reads the soak log — a rate refusal is "too fast, will pass", a
 * budget refusal is "out of money, will not pass without an operator" — and
 * `rate_limited` on the result is read downstream. A budget breach is
 * reported through `rate_limited` too because that is the field the pipeline
 * already understands as "the debate was not admitted"; the reason string is
 * what distinguishes them.
 */
export function spendCappedDebateResult(debate_id: string, reason: string): DebateResult {
  return {
    ...rateLimitedDebateResult(debate_id, reason),
    position: 'No position — the debate was not admitted under the LLM spend cap.',
  };
}

export function buildDebateStep(
  llmClient: LlmClient,
  /**
   * Required, not optional: #364 was a store that existed, was constructed,
   * and had no caller. An optional dependency here would let the production
   * composition root silently drop it again.
   */
  debateLog: DebateLogStore,
  /**
   * Required for exactly the same reason, and #388 is the proof it was needed:
   * `RateLimiter` was implemented, tested and exported, and constructed
   * nowhere in production. An optional parameter here would leave the
   * composition root free to drop it again and leave the system back on
   * `maxConcurrentInstruments: 1` as its only, incidental throttle.
   *
   * Positional and third so the omission is a COMPILE error rather than a
   * silently unpaced run.
   */
  rateLimiter: RateLimiter,
  /**
   * The hard dollar ceiling (ADR-0008). Required and positional for the third
   * time in this signature, and for the same reason: a budget control the
   * composition root is free to omit is a budget control that will eventually
   * be omitted. `UNCAPPED_SPEND` is the explicit way to say "no ceiling", so
   * that choice is visible at the call site instead of being the default.
   */
  spendCap: SpendCap,
  logger?: Logger,
  /**
   * #435: the live `analyst_weights` table. Optional so a test or backtest can
   * stay unweighted, supplied on the production path — without it the daily
   * cycle steps a weight nothing reads, which is this repo's dominant defect
   * class and the exact gap #377 resolved to close.
   */
  analystWeights?: AnalystWeightSource,
): TickSteps['debate'] {
  return async ({ trace_id, instrument, asset_class, views, clock }) => {
    // Hoisted out of the `runDebate` call: the SAME `Date` must go into
    // `debate_id`'s hash and into the row's `bar_timestamp`, or the row
    // claims a bar coordinate its own primary key does not encode.
    //
    // FLOORED as of #393. It used to be `clock.now()` raw, so a tick at
    // 14:32:07 wrote `bar_timestamp = 14:32:07` — the tick time, which is what
    // `created_at` already means. A replay stepping bars advances the clock TO
    // a bar close and would look up 14:30:00, missing every live row, so
    // replay-from-log (ADR-0003 §2) could not find the output it is required
    // to replay instead of re-calling the LLM. See `floorToBar` for why the
    // timeframe is an hour and not the tick cadence.
    const bar = floorToBar(clock.now());
    // Computed here, ahead of the debate, rather than read off the eventual
    // `DebateResult` (#326): the personas need it to attribute their spend
    // rows while the debate is still running, and a debate that THROWS partway
    // still billed for the calls it made. `computeDebateId` is the same pure
    // hash `runDebate` applies to the same three inputs, so this cannot drift
    // from the id on the resulting row — asserted in debate-adapter.test.ts.
    const debate_id = computeDebateId(instrument, bar, views);

    // ADMISSION, once, before anything is spent (#388). `reserve` is
    // synchronous and never parks the caller — see `RateLimitedLlmClient` for
    // why waiting was rejected — so this either lets the debate run at full
    // speed or refuses it outright. It books the debate against the window AND
    // checks that the worst case still fits the remaining call budget, which
    // is what stops a debate starting only to be cut off mid-round with three
    // rounds already billed.
    //
    // DELIBERATELY OUTSIDE the try/catch below, which is safe because `reserve`
    // is TOTAL over `AssetClass`: it returns a `ReserveResult` for every value
    // the type admits and throws on none of them. An asset class with no
    // `perAssetClass` entry falls back to `default` rather than erroring —
    // pinned by "RateLimiter.reserve is total over AssetClass" in
    // rate-limiter.test.ts, which exists for this call site specifically
    // (PR #390 review).
    //
    // The only inputs that CAN make it throw are a null config, a config with
    // no `default`, or a `Clock` that does not return a `Date` — each of which
    // requires defeating TypeScript, and each of which is a total, permanent
    // startup misconfiguration rather than a per-tick condition. Catching them
    // here would be actively worse than not: it would convert "this process is
    // misconfigured" into "this instrument silently never trades", which for a
    // 14-day unattended soak is indistinguishable from a quiet market. That
    // failure must stay loud.
    // BUDGET, before the rate-limit window is booked (ADR-0008). Ordered first
    // deliberately: `reserve` mutates the limiter's counters, and booking a
    // window for a debate the budget will refuse anyway would consume rate
    // allowance that a later, admissible debate needs. This check is a pure
    // read and mutates nothing, so refusing here costs the system nothing.
    const spend = spendCap.check();
    if (!spend.admitted) {
      logger?.log({
        trace_id,
        stage: 'debate',
        level: 'error',
        message:
          `debate: ${instrument} not started — ${sanitizeLogText(spend.reason ?? 'spend cap')}. ` +
          'No LLM call was made and no debate_log row is written; the tick will short-circuit ' +
          'at Trader with no_trade. THIS DOES NOT RESOLVE ITSELF: unlike a rate-limit refusal, ' +
          'the budget does not refill with time, so every subsequent tick will refuse ' +
          'identically until an operator raises the cap or starts a fresh run. Open positions ' +
          'are unaffected — their bracket legs remain live venue-side, and Execution, ' +
          'reconcile and fill ingestion all keep running.',
        payload: {
          instrument,
          asset_class,
          debate_id,
          spent_usd: spend.spent_usd,
          budget_usd: spend.budget_usd,
        },
      });
      return spendCappedDebateResult(debate_id, spend.reason ?? 'spend cap reached');
    }

    const reservation = rateLimiter.reserve(asset_class, WORST_CASE_LLM_CALLS_PER_DEBATE);
    if (!reservation.granted) {
      logger?.log({
        trace_id,
        stage: 'debate',
        level: 'warn',
        message:
          `debate: ${instrument} not started — ${sanitizeLogText(reservation.reason)}. No LLM ` +
          'call was made and no debate_log row is written; the tick will short-circuit at ' +
          'Trader with no_trade. Persistent refusals mean rateLimiterConfig is sized under the ' +
          "universe's real debate rate, not that the market is quiet.",
        payload: { instrument, asset_class, debate_id },
      });
      return rateLimitedDebateResult(debate_id, reservation.reason);
    }

    // METERING, per call, for the debate just admitted. Wrapped here rather
    // than once at the composition root because the limiter's counters are
    // per-asset-class and `LlmRequest` carries no instrument — this is the
    // innermost layer that still knows which class to bill.
    const personas = buildDebatePersonas(
      new RateLimitedLlmClient(llmClient, rateLimiter, asset_class),
      trace_id,
      clock,
      debate_id,
    );

    // LATENCY BUDGET (#374). `enforceLatencyBudget` was implemented, tested,
    // exported — and called by nothing, so a pathological debate held the
    // tick, its LLM connections and its rate-limit budget for as long as the
    // provider took. Over an unattended 14-day soak (#238) that has no
    // ceiling at all.
    //
    // The budget is per asset class (`LATENCY_BUDGET_MS`: crypto 15s, stocks
    // 60s) and `asset_class` is already on the step's input, so the lookup
    // needs nothing new. NOTE: #346 disputes the crypto figure as
    // arithmetically impossible at max rounds — this wires the MECHANISM at
    // the values the spec currently states; #346 still owns the values.
    //
    // `signal` is threaded into `runDebate`, which `throwIfAborted`s before
    // every persona call, so a timed-out debate stops spending instead of
    // running to completion with its answers discarded (#347 built that
    // contract for this call site).
    //
    // A timed-out debate still RESOLVES — partial synthesis when a round
    // completed, low-confidence fallback when none did — so it flows into
    // `persistDebateLog` like any other resolved debate, which is exactly
    // what that function's doc comment already anticipated.
    let result: DebateResult;
    try {
      result = await enforceLatencyBudget({
        assetClass: asset_class,
        trace_id,
        debate_id,
        produceResult: (signal) => runDebate({ views, instrument, bar }, personas, { signal }),
        getCurrentState: personas.getCurrentState,
        // `JsonDebateLogger` over the step's own sink, so the timeout line
        // lands in the same stream as every other debate line. A step built
        // without a logger (tests) gets a no-op sink rather than an optional
        // logger on `enforceLatencyBudget`, whose contract is that a fired
        // budget is always recorded somewhere.
        logger: new JsonDebateLogger(logger ?? { log: () => {} }),
      });
    } catch (cause) {
      logDebateFailure({ logger, trace_id, instrument, bar, views, cause });
      throw cause;
    }

    // #435 part 2 — the Debate Engine reads `analyst_weights`, David's
    // resolution on #377.
    //
    // AFTER `runDebate`, so `debate_id` keeps meaning what the frozen
    // cross-spec contract says it means: the identity of the debate's INPUTS.
    // The spec recorded a collision worry here — same id, different weights,
    // different result — and it is unreachable: weights move only in
    // `runDailyCycle`, the bar is an hour, so a weight step cannot happen
    // inside a bar and two debates sharing an id necessarily ran under
    // identical weights. See `weighted-conviction.ts` for the full argument.
    //
    // The WEIGHTED result is what gets logged, so replay-from-log restores the
    // conviction the Trader actually sized on rather than the pre-weight one.
    const weighted =
      analystWeights === undefined
        ? result
        : applyAnalystWeights(result, analystWeights.getAnalystWeights());

    persistDebateLog({
      store: debateLog,
      result: weighted,
      instrument,
      bar,
      clock,
      trace_id,
      logger,
    });
    return weighted;
  };
}

/**
 * Makes the no-row case visible rather than silent (see `persistDebateLog`).
 * `debate_id` is recomputed from the same (instrument, bar, views) the failed
 * debate would have hashed, so an operator can grep the log for the id that
 * is missing from `debate_log`.
 */
function logDebateFailure(params: {
  logger: Logger | undefined;
  trace_id: string;
  instrument: string;
  bar: Date;
  views: AnalystView[];
  cause: unknown;
}): void {
  const { logger, trace_id, instrument, bar, views, cause } = params;
  if (logger === undefined) {
    return;
  }
  logger.log({
    trace_id,
    stage: 'debate',
    level: 'error',
    message:
      `debate: ${instrument} failed before resolving — no debate_log row is written for a ` +
      'debate that produced no result (the write-once debate_id stays free for the re-run): ' +
      sanitizeLogText(cause instanceof Error ? cause.message : String(cause)),
    payload: { instrument, debate_id: computeDebateId(instrument, bar, views) },
  });
}
