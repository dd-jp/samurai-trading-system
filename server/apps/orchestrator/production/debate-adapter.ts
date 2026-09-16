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
 * - `confidence`: `computeConvictionScore(views, roundStances, mediatorStance)`
 *   — a real, existing function. `roundStances` (cumulative across rounds) is
 *   accumulated in this closure the same way `runDebate` accumulates its
 *   own copy internally, since `RoundContext` doesn't expose one.
 *
 *   **The third argument is #625's fix and the reason this mapping is no
 *   longer circular.** Because the `stances` above echo `view.direction`, and
 *   `finalPositionFor` falls back to `view.direction` when an analyst has no
 *   round stance, conviction used to be a pure function of the analyst views:
 *   the debate could not move it by any amount, in any direction, on any
 *   round — four LLM calls per run producing a number that was already
 *   determined before the first one was made. Measured over 96 debates, it
 *   contributed exactly zero. Passing the mediator's own `stance` makes the
 *   debate's verdict a participant in the score. Bull and bear are still not
 *   passed: they argue the side they were assigned, so their stance carries
 *   no information about conviction.
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
 * because this is where the row's inputs are: the resolved `DebateResult`, the
 * instrument, the trace id and the clock. The bar is no longer among those
 * reasons — since #687 it rides on `DebateResult.bar_timestamp`, so
 * `buildDebateLog` projects it off the result and no caller can stamp a row
 * with a bar the `debate_id` does not encode. See
 * `persistDebateLog` for what is written when a debate does not converge, and
 * what is deliberately not written when one fails partway.
 */
import type {
  AnalystRoundStance,
  AnalystView,
  AssetClass,
  DebateResult,
  LlmClient,
  SpendCap,
} from '../../../pipeline/debate-engine/index.js';
import {
  applyAnalystWeights,
  buildAnalystContributions,
  buildDebateLog,
  buildDebateRoundLogRows,
  computeConvictionScore,
  computeDebateId,
  type DebatePersonas,
  type DebaterPersona,
  detectDisagreements,
  enforceLatencyBudget,
  JsonDebateLogger,
  LlmAdmissionRefusedError,
  llmCallsPerDebate,
  MAX_ROUNDS,
  MAX_ROUNDS_BY_ASSET_CLASS,
  type MediatorAssessment,
  type MediatorPersona,
  type PartialDebateState,
  type PersonaResponse,
  type RateLimiter,
  type RoundContext,
  type RoundStance,
  type RoundVerdict,
  runBearPersona,
  runBullPersona,
  runDebate,
  runMediatorPersona,
  spendCapRefusalRemedy,
} from '../../../pipeline/debate-engine/index.js';
import {
  type Clock,
  type DebateLog,
  type DebateLogStore,
  describeThrownSafely,
  type Logger,
  sanitizeLogText,
} from '../../../shared/index.js';
import type { TickSteps } from '../types.js';

/** The one method the debate step needs from the tuning store (#435) */
export interface AnalystWeightSource {
  getAnalystWeights(): Record<string, number>;
}

import {
  checkGateRefusalRate,
  type GateRefusalRateAlertChannel,
  type GateRefusalRateMonitor,
  type GateRefusalWindowSource,
  type LlmGateRefusalSink,
} from './gate-refusal-rate-guard.js';
import {
  checkLlmFailureRate,
  type LlmFailureRateAlertChannel,
  type LlmFailureRateMonitor,
  type LlmFailureRateWindowSource,
} from './llm-failure-rate-guard.js';
import { RateLimitedLlmClient } from './rate-limited-llm-client.js';

/**
 * `buildDebateStep`'s #1396 dependency bundle — bundled rather than three
 * more positional parameters, and optional as a whole: several hundred
 * existing tests/backtest/smoke callers construct this step with no window
 * source at all, and `checkLlmFailureRate` is skipped entirely when this is
 * absent (same "optional means untested paths keep their old behaviour"
 * reasoning `analystWeights` already documents on this function)
 */
export interface LlmFailureRateGuardDeps {
  windowSource: LlmFailureRateWindowSource;
  monitor: LlmFailureRateMonitor;
  alertChannel: LlmFailureRateAlertChannel | undefined;
}

/**
 * `buildDebateStep`'s #1533 dependency bundle, the sibling of
 * `LlmFailureRateGuardDeps` above and deliberately NOT merged into it: the two
 * signals share a store and a call site but nothing else — different window
 * read, different denominator, different threshold, different latch, different
 * alert (see `gate-refusal-rate-guard.ts`'s "Why separate"). Optional as a
 * whole for the same reason its sibling is.
 */
export interface GateRefusalRateGuardDeps {
  windowSource: GateRefusalWindowSource;
  monitor: GateRefusalRateMonitor;
  alertChannel: GateRefusalRateAlertChannel | undefined;
  /**
   * Where a gate-refused debate is recorded, the only place it is written.
   * Required (not optional like the rest of this bundle): a caller supplying
   * this bundle at all wants refusals counted, and `SqliteDebateLogStore` —
   * the same concrete store already passed as `windowSource` — implements it
   * directly.
   */
  gateRefusalSink: LlmGateRefusalSink;
}

/** Fire-and-forget window check, invoked on both the completed-debate and the gate-refused path (#1533) */
function checkGateRefusalRateIfConfigured(
  guard: GateRefusalRateGuardDeps | undefined,
  logger: Logger | undefined,
  now: Date,
): void {
  if (guard === undefined) return;
  void checkGateRefusalRate(
    {
      windowSource: guard.windowSource,
      monitor: guard.monitor,
      alertChannel: guard.alertChannel,
      logger,
    },
    now,
  );
}

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
  /**
   * The round cap these personas were built for, echoed back so the caller
   * passes THE SAME value to `runDebate` (#581, PR #583 review). The
   * mediator's final-round check gates the once-per-debate
   * `detectDisagreements` call on this cap; reading it off the personas
   * object instead of a second independent argument is what makes the two
   * caps structurally unable to drift.
   */
  maxRounds: number;
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
  /**
   * The round cap THIS debate runs under (#581). The mediator's "is this the
   * final round" check below gates the once-per-debate `detectDisagreements`
   * call on it, and it is echoed back on the returned personas
   * (`DebatePersonasWithState.maxRounds`) for the caller to hand to
   * `runDebate` — read it from there rather than repeating the value, or a
   * drift between the two would silently skip disagreement detection.
   */
  maxRounds: number = MAX_ROUNDS,
  /**
   * Reaches only `detectDisagreements` (#1394), which had no logger and so
   * swallowed every semantic-detection failure without naming it. Optional and
   * last so the suite's existing persona builders are unchanged.
   */
  logger?: Logger,
): DebatePersonasWithState {
  let lastBull: PersonaResponse | undefined;
  let lastBear: PersonaResponse | undefined;
  const accumulatedStances: AnalystRoundStance[] = [];
  const roundVerdicts: RoundVerdict[] = [];
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

      const isFinalRound = response.converged || context.round === maxRounds;
      const disagreement = isFinalRound
        ? await detectDisagreements(
            context.views,
            llmClient,
            context.signal,
            { trace_id, debate_id },
            logger,
          )
        : { summary: '', conflicts: [], method: 'directional_fallback' as const };

      // `response.stance` — the mediator's actual verdict — is passed as a
      // participant so the debate can move conviction at all (#625 defect 2)
      // Before this, conviction was a pure function of the analyst views: the
      // `stances` built above echo `view.direction`, and `finalPositionFor`
      // falls back to `view.direction` anyway, so every round contributed
      // exactly zero to a score we were paying four LLM calls per run to
      // produce. The mediator is the only debate output carrying information —
      // bull and bear argue the side they were assigned, so their stance says
      // nothing about conviction (see `computeDirectionalConsensus`)
      const confidence = computeConvictionScore(context.views, accumulatedStances, response.stance);
      roundVerdicts.push({ round: context.round, direction: response.stance, confidence });

      // Recorded AFTER the round's LLM calls returned, so this is always a
      // completed round (#374). `debate_id` is required by
      // `PartialDebateState` and is what the timeout path stamps on its
      // result, so a persona set built without one (the pre-#326 test
      // callers) reports no state rather than inventing an id that would not
      // match the `debate_log` row
      if (debate_id !== undefined) {
        currentState = {
          synthesis: response.rationale,
          position: `${response.stance}: ${response.rationale}`,
          confidence,
          contributions: buildAnalystContributions(context.views, accumulatedStances),
          disagreement_summary: disagreement.summary,
          // A partial state is non-converged by construction, and
          // `runDebate` holds the invariant that a non-converged result
          // carries non-empty `open_items` so Trader/Risk can apply caution
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
          // Snapshot rather than the live array, matching `contributions`
          // above (`buildAnalystContributions` over a fresh copy of
          // `accumulatedStances`) — a caller holding an old `currentState`
          // reads what had completed AT THAT SNAPSHOT, not whatever
          // `roundVerdicts` grows to later
          round_verdicts: [...roundVerdicts],
          debate_id,
        };
      }

      return {
        converged: response.converged,
        stances,
        synthesis: {
          synthesis: response.rationale,
          // Not derivable from any existing persona/analysis output — the
          // one genuine invention in this adapter (see file doc comment)
          // Not load-bearing: Trader reads only direction/confidence
          position: `${response.stance}: ${response.rationale}`,
          confidence,
          direction: response.stance,
          disagreement_summary: disagreement.summary,
          open_items: disagreement.conflicts.map((conflict) => conflict.nature),
        },
      };
    },
  };

  return { bull, bear, mediator, clock, getCurrentState: () => currentState, maxRounds };
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
 * IDEMPOTENCY — first-write-wins, checked before the insert. This guard is now
 * a BACKSTOP rather than the primary mechanism: since #617, `buildDebateStep`
 * checks for the existing row immediately after computing `debate_id` and
 * before any LLM call, and returns the persisted debate. Reaching this guard
 * therefore means a debate was fully paid for and is about to be thrown away —
 * which is what #617 measured happening on 29 of 40 debates. The check stays
 * because it is cheap and because a second process writing the same shared
 * store can still race it.
 *
 * A retry within the same bar recomputes the SAME `debate_id`, so a
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
 *
 * Exported for `debate-adapter.test.ts` alone (#1558 review) — driving a
 * PARTIAL/timed-out debate with `rounds_completed >= 1` through this
 * function is otherwise unreachable via `buildDebateStep`: that function
 * hardwires `maxRounds` to `MAX_ROUNDS_BY_ASSET_CLASS[asset_class]` (line
 * ~1069), which is 1 for both asset classes as of #1080, so a debate that
 * times out with any partial round data already recorded cannot be produced
 * through the public step today. This is the same structural fact #1517's
 * flip-rate report states: nothing exercises this branch in production
 * either, currently.
 */
export function persistDebateLog(params: {
  store: DebateLogStore;
  result: DebateResult;
  instrument: string;
  clock: Clock;
  trace_id: string;
  logger: Logger | undefined;
}): DebateLog | undefined {
  const { store, result, instrument, clock, trace_id, logger } = params;

  const winner = store.getByDebateId(result.debate_id);
  if (winner !== undefined) {
    logger?.log({
      trace_id,
      stage: 'debate',
      event: 'debate_log_duplicate_write',
      level: 'warn',
      message:
        `debate: ${instrument} already has a debate_log row for debate_id ` +
        `${result.debate_id} — skipping the duplicate write (first write wins). ` +
        'SINCE #617 THIS SHOULD BE RARE: `buildDebateStep` checks for the row before the ' +
        'debate runs and replays it, so reaching here means a debate was paid for and then ' +
        'discarded. The remaining legitimate cause is a row written concurrently by another ' +
        'process against the same shared store.',
      payload: { instrument, debate_id: result.debate_id },
    });

    // Handed back so the caller can converge on the STORED row rather than
    // returning its own discarded sample. First-write-wins on the table but
    // last-write-wins in the Trader is the attribution mismatch #617 exists to
    // remove: the Feedback Loop would later attribute the trade to the winner's
    // row while the position was sized on the loser's confidence
    return winner;
  }

  // `trace_id` (#426): the tick that actually ran this debate. First-write-wins
  // is already this function's rule — the guard above returns before writing —
  // and that is exactly the semantics the column needs, since a retried tick
  // within the same bar carries a FRESH trace against the same content-hashed
  // `debate_id` and must not overwrite the attribution of the debate it did
  // not run
  const written_at = clock.now();
  // One transaction (`writeLogWithRounds`): the FK on debate_round_log
  // (migration 0064) always resolves since debate_log commits first inside
  // it, and a throw from either write leaves neither row — this function's
  // own first-write-wins guard above (`getByDebateId`) would otherwise block
  // every retry from ever gaining the round rows for a debate_log row that
  // made it in alone
  store.writeLogWithRounds(
    buildDebateLog(result, instrument, written_at, trace_id),
    buildDebateRoundLogRows(result, written_at),
  );

  return undefined;
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
 *
 * The arithmetic lives in `llmCallsPerDebate` (debate-engine's
 * `latency-budget.ts`), not here: the latency budget is sized from the same
 * call count this reserves for, and two copies of it in two layers is the
 * drift this file's own comment warns about one paragraph up.
 */
export const WORST_CASE_LLM_CALLS_PER_DEBATE = llmCallsPerDebate(MAX_ROUNDS);

/**
 * The same worst case, but at the ASSET CLASS's round cap (#581). Crypto is
 * capped at one round (`MAX_ROUNDS_BY_ASSET_CLASS`), so reserving the global
 * worst case would book 10 calls for a debate that can only ever make 4 —
 * starving later debates of rate-limit admission for calls that cannot happen.
 * `WORST_CASE_LLM_CALLS_PER_DEBATE` above stays the SIZING bound (`maxLlmCalls`
 * multiples in the paper profile): a ceiling sized for the largest debate still
 * safely covers the smaller one.
 */
export function worstCaseLlmCallsForAssetClass(assetClass: AssetClass): number {
  return llmCallsPerDebate(MAX_ROUNDS_BY_ASSET_CLASS[assetClass]);
}

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
export function rateLimitedDebateResult(
  debate_id: string,
  bar: Date,
  reason: string,
): DebateResult {
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
    // The bar this tick belongs to, even though no debate ran (#687). The
    // Trader short-circuits on `confidence: 0` and never keys an order off it,
    // but the field is required by the contract precisely so that no producer
    // gets to leave the coordinate unstated for a later consumer to re-derive
    bar_timestamp: bar,
    // `rate_limited` already makes `debateWasDegraded` true; see
    // DebateResult.read's docblock for why this still sets `read: true`
    read: true,
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
export function spendCappedDebateResult(
  debate_id: string,
  bar: Date,
  reason: string,
): DebateResult {
  return {
    ...rateLimitedDebateResult(debate_id, bar, reason),
    position: 'No position — the debate was not admitted under the LLM spend cap.',
  };
}

/**
 * What a debate the account-wide in-flight gate refused returns (#1080).
 *
 * The third member of the not-admitted family, and it ships for the reason
 * #388's comment above already argues: a gate refusal is routine and expected
 * under load — at the shipped cap of 1 it is the designed outcome for four of
 * every six instruments in a pass — so logging it as an `error`-level
 * instrument failure is the wrong signal for a degrade-not-fail path. Until
 * this function existed the refusal propagated out of `enforceLatencyBudget`
 * uncaught and produced, per refused instrument per pass, a `debate_unresolved`
 * error line, an `instrument_pass_failed` error line, an `audit_log` row
 * reading `decision: 'crashed'`, and — because `tick-loop.ts`'s refusal
 * carve-out tests `LlmRefusalError`, which this is not — a rescind that
 * retried the bar and re-billed every persona that had already answered.
 *
 * ## `rounds_completed: 0` does not mean nothing ran
 *
 * It means nothing is being handed downstream, which is `rateLimitedDebateResult`'s
 * contract and the fail-safe direction. The gate can refuse the FIRST persona
 * call, in which case no model was asked anything; it can equally refuse the
 * third, when an MI refresh takes the permit mid-debate — `debate-engine-spec.md`
 * is explicit that this is not rare. In that second shape the earlier persona
 * calls were issued and billed and their answers are discarded here. That is
 * not a regression: the throw discarded them too, and then re-billed them on
 * every retry until #785 forfeited the bar.
 *
 * ## Countability (#1080 AC4)
 *
 * No `debate_log` row is written — same reasoning as `rateLimitedDebateResult`,
 * and it means `LlmFailureRateGuard` sees a refusal in neither its numerator
 * nor its denominator. Refusals are counted off the log instead: the gate's own
 * `llm_call_failed` line carries `reason`, `queue_depth` and `waited_ms`, and
 * `debate_refused_gate` below names the instrument. The `audit_log` row reads
 * `not_admitted` (`debateDecisionWord`), distinct from both `no_trade` and
 * `crashed`.
 */
export function gateRefusedDebateResult(
  debate_id: string,
  bar: Date,
  reason: string,
): DebateResult {
  return {
    ...rateLimitedDebateResult(debate_id, bar, reason),
    position: 'No position — the debate was not admitted under the in-flight LLM cap.',
  };
}

/**
 * The debate this bar already resolved, rebuilt from its `debate_log` row
 * (#617).
 *
 * NOT a refusal shape like the two above — this is a real debate with a real
 * conviction, and the Trader is meant to act on it exactly as it would have
 * acted on the live run. `rate_limited` is deliberately absent for that reason:
 * nothing was refused.
 *
 * The point of returning the PERSISTED row rather than caching the live result
 * in memory is that it closes the gap #617 measured. Whatever the Trader sizes
 * on within a bar is now, by construction, the row the Feedback Loop will later
 * attribute the trade to — they cannot be different samples of the same debate,
 * because they are the same bytes. It also survives a process restart mid-bar.
 *
 * `latency_ms: 0` is honest: this call spent no time debating. The real
 * debate's latency belongs to the tick that ran it, and `llm_spend` already
 * records it there (#326).
 *
 * Takes a `ReplayableDebateLog`, so the six replay fields are required by the
 * TYPE rather than defaulted at the point of use. There are no `??` fallbacks
 * here for that reason: a row missing any of them cannot reach this function,
 * because `isReplayable` is what narrows it. The previous shape defaulted them
 * and so could silently emit `synthesis: ''` on a partial row.
 *
 * `debate_id` is read off the row rather than taken as a parameter: the row was
 * looked up BY that id, so a second copy could only ever be the same value or a
 * bug, and two sources of truth for the id the Trader, Verdict and Feedback Loop
 * all join on is not a trade worth making.
 */
export function replayedDebateResult(persisted: ReplayableDebateLog): DebateResult {
  return {
    synthesis: persisted.synthesis,
    position: persisted.position,
    confidence: persisted.confidence,
    contributions: persisted.contributions,
    disagreement_summary: persisted.disagreement_summary,
    open_items: persisted.open_items,
    converged: persisted.converged,
    rounds_completed: persisted.rounds,
    latency_ms: 0,
    direction: persisted.direction,
    debate_id: persisted.debate_id,
    // Read off the ROW, exactly like `debate_id` above and for the same reason
    // (#687). This is the case a re-derivation gets wrong most cheaply: the row
    // was written in bar N, this replay may be serving a tick minutes later —
    // including a tick after a process restart — and the intent must be keyed
    // to the bar the row records, not to whenever the replay happened to run
    bar_timestamp: persisted.bar_timestamp,
    // A persisted row is a debate that actually ran. Hardcoded rather than
    // read off `persisted` because `debate_log` has no `read` column to read
    // it back from (#1418) — harmless today since no producer ever persists
    // `read: false`, but a future one that did would resurrect here as
    // `true`, reversing exactly the classification #1393 built `read` to
    // protect
    read: true,
  };
}

/** A `DebateLog` carrying every replay field the Trader consumes */
export type ReplayableDebateLog = DebateLog & Required<Pick<DebateLog, ReplayField>>;

type ReplayField =
  | 'confidence'
  | 'synthesis'
  | 'position'
  | 'disagreement_summary'
  | 'open_items'
  | 'converged';

const REPLAY_FIELDS: readonly ReplayField[] = [
  'confidence',
  'synthesis',
  'position',
  'disagreement_summary',
  'open_items',
  'converged',
];

/**
 * Whether a persisted row can stand in for a live debate.
 *
 * **Checking `confidence` alone was not enough.** The six replay fields are
 * independently optional on `DebateLog` and `writeLog` persists whatever subset
 * it is given, so "written after migration 0026" and "carries all six" are not
 * the same statement. A row with a confidence and nothing else replayed as
 * `synthesis: ''`, `position: ''`, `converged: false` — a fabricated debate
 * presented to the Trader as a real one, which is worse than the pre-#617
 * behaviour of simply re-running it.
 *
 * All six or none: a partial row falls through and the debate re-runs, which is
 * the same degradation path a pre-0026 row already takes.
 */
export function isReplayable(persisted: DebateLog | undefined): persisted is ReplayableDebateLog {
  return persisted !== undefined && REPLAY_FIELDS.every((field) => persisted[field] !== undefined);
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
  /**
   * #1396: the llm-failure-rate window read + edge-triggered monitor +
   * alert channel, bundled (see `LlmFailureRateGuardDeps`'s doc). Optional
   * for the same reason `analystWeights` is — every existing test/backtest
   * caller of this function constructs it with no guard at all, and must
   * keep compiling unchanged.
   */
  llmFailureRateGuard?: LlmFailureRateGuardDeps,
  /**
   * #1533: the gate-refusal-rate window read + monitor + alert channel, plus
   * the sink the refusal path writes to. A SEPARATE parameter from
   * `llmFailureRateGuard` because it is a separate signal — see
   * `GateRefusalRateGuardDeps`. Optional for the same reason.
   */
  gateRefusalRateGuard?: GateRefusalRateGuardDeps,
): TickSteps['debate'] {
  /**
   * The debate each bar RESOLVED to, per instrument (#743, closing #781's
   * within-process exposure): opening-boundary epoch ms → the `debate_id` a
   * completed pass produced for that bar.
   *
   * The #617 short-circuit below is CONTENT-addressed — it hashes the analyst
   * views — and its correctness premise ("views are byte-identical within one
   * bar") held only while every analyst read 1h bars. #742 moved the technical
   * read to 5m bars, so re-computed views drift WITHIN a debate bar and the
   * content hash misses. The tick/decision split is the structural fix (views
   * are computed once per bar, so the hash is stable per bar by construction);
   * this memo is the belt under that suspender: even if the decision gate
   * re-enters a bar — a forced-open gate in a mutation test, a rescinded claim
   * retried after a crash that had already persisted its row — the bar's
   * resolved `debate_id` is remembered and its PERSISTED row replayed, so the
   * Trader can never receive a second confidence sample for the same bar from
   * this step.
   *
   * It dedupes on the SAME key the #617 fix uses — the `debate_id`, resolved
   * through the same `getByDebateId`/`isReplayable` pair — not on a second
   * notion of "new bar": the memo only remembers WHICH id the bar produced,
   * and the row itself remains the single source of the replayed content.
   *
   * In-memory and restart-clean, deliberately: `DebateLogStore` exposes no
   * by-bar lookup (`ports.ts` — `writeLog`/`getByDebateId` only), so a
   * restart mid-bar re-runs the analysts once and, if their views drifted
   * across the restart, pays for one fresh debate.
   *
   * RECORDED DECISION (#785, moved from #781 when #783 closed it): one
   * duplicate debate per instrument per restart is ACCEPTED rather than
   * closed by widening `DebateLogStore` with a by-bar accessor. Three things
   * bound the cost rather than eliminate it, but bound it tightly enough that
   * a port widening is not worth its own migration + SQLite implementation +
   * test surface right now:
   *
   *   1. It fires at most ONCE per instrument per restart — the first tick
   *      after a restart either lands on the SAME bar the process crashed
   *      mid-way through (one extra debate, then the new process's own
   *      per-bar memo takes over for the rest of that bar) or a later bar
   *      (no duplicate at all, since the fresh process has no residual claim
   *      to re-enter).
   *   2. Deploys are a HUMAN action here (single-MacBook host, no
   *      auto-restart supervisor in front of this process) — a restart
   *      mid-bar is not a steady-state occurrence the way a tick is; it is
   *      bounded by how often the operator restarts the process, which is
   *      orders of magnitude below the bar cadence.
   *   3. The cost itself is one LLM debate call, not a correctness violation
   *      — the duplicate is a wasted spend, not a duplicate ORDER (the #617
   *      short-circuit and this same memo still prevent the Trader from ever
   *      seeing two confidence samples for one bar within a single process's
   *      lifetime; only the cross-restart case can double-pay for the debate
   *      itself).
   *
   * A by-bar `DebateLogStore` accessor remains the right fix if restart
   * frequency or the duplicate's cost ever changes enough to matter — this
   * decision is about today's shape of both, not a permanent ceiling on the
   * port.
   */
  const resolvedBarByInstrument = new Map<string, { barMs: number; debate_id: string }>();

  return async ({ trace_id, instrument, asset_class, views, clock, bar }) => {
    // The SAME `Date` must go into `debate_id`'s hash and into the row's
    // `bar_timestamp`, or the row claims a bar coordinate its own primary key
    // does not encode
    //
    // INHERITED as of #743, not floored here. This step used to floor its own
    // `clock.now()` (#393), which was a SECOND derivation of the bar: the
    // decision gate had already floored the tick time to decide this pass
    // should debate at all, and two clock reads agree only while both land in
    // the same bar (#687's defect shape, one seam up). The gate is now the
    // single source — `TickContext.decision_bar.open_time`, threaded through
    // `TickSteps.debate`'s `bar` — so a debate straddling a bar boundary
    // stays keyed to the bar the gate opened. See `floorToBar` for why the
    // grid is an hour and not the tick cadence
    // Computed here, ahead of the debate, rather than read off the eventual
    // `DebateResult` (#326): the personas need it to attribute their spend
    // rows while the debate is still running, and a debate that THROWS partway
    // still billed for the calls it made. `computeDebateId` is the same pure
    // hash `runDebate` applies to the same three inputs, so this cannot drift
    // from the id on the resulting row — asserted in debate-adapter.test.ts
    const debate_id = computeDebateId(instrument, bar, views);

    // SAME-BAR MEMO (#743) — see `resolvedBarByInstrument`. Checked before the
    // content gate below because it is immune to the view drift #742
    // introduced: if THIS bar already resolved to a debate, that debate's
    // persisted row is the answer regardless of what freshly-computed views
    // would hash to. Falls through when the remembered row is not replayable
    // (pre-0026 rows), exactly as the content gate does
    function replayFromSameBarMemo(): DebateResult | undefined {
      const resolved = resolvedBarByInstrument.get(instrument);
      if (resolved !== undefined && resolved.barMs === bar.getTime()) {
        const remembered = debateLog.getByDebateId(resolved.debate_id);
        if (isReplayable(remembered)) {
          logger?.log({
            trace_id,
            stage: 'debate',
            level: 'info',
            message:
              `debate: ${instrument} replayed from debate_log for debate_id ` +
              `${resolved.debate_id} — this bar already resolved to a debate this process ran, ` +
              'so a fresh run would hand the Trader a second confidence sample for the same bar ' +
              '(#617/#781). No LLM call was made.',
            payload: { instrument, asset_class, debate_id: resolved.debate_id, replayed: true },
          });
          return replayedDebateResult(remembered);
        }
      }
      return undefined;
    }
    const memoReplay = replayFromSameBarMemo();
    if (memoReplay !== undefined) {
      return memoReplay;
    }

    // SAME-BAR SHORT-CIRCUIT (#617), before the spend cap, the rate limiter and
    // every LLM call
    //
    // The orchestrator ticks every 2 minutes (`paperStartingProfile
    // .tickIntervalMs`, ADR-0008 §2 as amended — this comment said 15 minutes
    // long after #670 retuned it); debates are keyed to 1h bars, and since the
    // tick/decision split (#743) this step runs at most once per bar anyway,
    // so this gate's remaining production work is the crash-retry and
    // restart-within-a-bar cases. All three `debate_id` inputs are bar-keyed —
    // instrument, the gate's floored bar, and the analyst views, which are
    // DETERMINISTIC functions of closed bars (there is no LLM client in
    // `pipeline/analysts/`; `key_points` are templated numeric strings and a
    // constant NO_DATA line). Before the split, every non-first tick of a bar
    // recomputed the same id, re-ran a full debate, and discarded it at the
    // write: 29 of 40 debates in the soak's first five hours warned on the
    // duplicate. NOTE #742 weakened the determinism premise WITHIN a bar (the
    // technical read is 5m now), which is what the memo above exists for
    //
    // Two things were wrong with that, and cost was the smaller one. `debate_log`
    // kept tick 1's row while the Trader sized on tick N's confidence, so the
    // Feedback Loop attributed trades to a different sampling of the same debate
    // — corrupted measurement in a soak whose whole purpose is measurement. And
    // because each re-run is a fresh non-deterministic sample, its confidence
    // could drift up by `scale_in_conviction_delta` and open an extra lot on the
    // same bar
    //
    // Returning the persisted debate makes the Trader's input stable within a
    // bar. #617 flagged that as a deliberate decision because it means "intra-bar
    // price moves no longer get a fresh debate" — but they never did: no live
    // price is an input to the debate at all, only the closed bars the analysts
    // read. A re-run could only produce a different SAMPLE of an identical
    // question, never a different answer to a new one. Intra-bar price still
    // reaches the Trader through `mark`, which is a separate input and unchanged
    //
    // A row written before migration 0026 carries none of the six replay fields,
    // and confidence is what position sizing is a function of. Such a row is not
    // replayable, so this falls through and re-runs the debate rather than
    // trading on a reconstructed blank. `isReplayable` demands all six rather
    // than confidence alone, because they are independently optional and a
    // partial row would otherwise replay as a fabricated empty debate
    function replayFromDebateLog(): DebateResult | undefined {
      const persisted = debateLog.getByDebateId(debate_id);
      if (isReplayable(persisted)) {
        // The bar resolved to this id (a restart's first tick landing on a row a
        // previous process wrote) — remember it, so subsequent same-bar entries
        // stop depending on the views hashing identically (#743)
        resolvedBarByInstrument.set(instrument, { barMs: bar.getTime(), debate_id });
        logger?.log({
          trace_id,
          stage: 'debate',
          level: 'info',
          message:
            `debate: ${instrument} replayed from debate_log for debate_id ${debate_id} — this ` +
            'tick shares a 1h bar with an earlier one and every debate input is bar-keyed, so a ' +
            'fresh debate would re-sample an identical question. No LLM call was made.',
          payload: { instrument, asset_class, debate_id, replayed: true },
        });
        return replayedDebateResult(persisted);
      }
      return undefined;
    }
    const persistedReplay = replayFromDebateLog();
    if (persistedReplay !== undefined) {
      return persistedReplay;
    }

    // ADMISSION, once, before anything is spent (#388). `reserve` is
    // synchronous and never parks the caller — see `RateLimitedLlmClient` for
    // why waiting was rejected — so this either lets the debate run at full
    // speed or refuses it outright. It books the debate against the window AND
    // checks that the worst case still fits the remaining call budget, which
    // is what stops a debate starting only to be cut off mid-round with three
    // rounds already billed
    //
    // DELIBERATELY OUTSIDE the try/catch below, which is safe because `reserve`
    // is TOTAL over `AssetClass`: it returns a `ReserveResult` for every value
    // the type admits and throws on none of them. An asset class with no
    // `perAssetClass` entry falls back to `default` rather than erroring —
    // pinned by "RateLimiter.reserve is total over AssetClass" in
    // rate-limiter.test.ts, which exists for this call site specifically
    // (PR #390 review)
    //
    // The only inputs that CAN make it throw are a null config, a config with
    // no `default`, or a `Clock` that does not return a `Date` — each of which
    // requires defeating TypeScript, and each of which is a total, permanent
    // startup misconfiguration rather than a per-tick condition. Catching them
    // here would be actively worse than not: it would convert "this process is
    // misconfigured" into "this instrument silently never trades", which for a
    // 14-day unattended soak is indistinguishable from a quiet market. That
    // failure must stay loud
    // BUDGET, before the rate-limit window is booked (ADR-0008). Ordered first
    // deliberately: `reserve` mutates the limiter's counters, and booking a
    // window for a debate the budget will refuse anyway would consume rate
    // allowance that a later, admissible debate needs. This check is a pure
    // read and mutates nothing, so refusing here costs the system nothing
    //
    // Being a pure read with no reservation is also its overshoot exposure
    // (#1013 fix-up M2): concurrent instruments can all read the SAME
    // pre-spend `cost_usd` total and all pass `check()` before any of their
    // spend is recorded, so the cap's overshoot bound scales with how many
    // debates can be concurrently admitted — at #1013's width 6
    // (`min(6, universe.length) = 4` concurrent today, #669's reentrancy
    // guard), worst case is ~4 debates over budget at the measured
    // ~$0.0060/debate rate (`paper-profile.ts`'s cost-per-day derivation),
    // i.e. ~$0.024 — accepted as financially trivial.
    //
    // (#969) The debate unit is no longer the largest one sharing this cap. A
    // retrieving market-intelligence call (`x_search`) costs ~$0.02 at the
    // default 3 results and a measured $0.089 at 10, because search results
    // ride in the prompt. The MI agents are composed SEQUENTIALLY for exactly
    // this reason (`composeMarketIntelligence`), so they cannot race each
    // other — but they can still race a debate through the same check. The
    // overshoot bound is therefore ~$0.024 + one MI call, not ~$0.024. Still
    // trivial against a $50 cap; recompute it if either unit moves again. Unlike `RateLimiter`,
    // which pairs a real reservation (`debatesUsed`) with a derived call
    // ceiling, `SpendCap` has no analogous reservation; nothing in this
    // repo's history says that was a deliberate trade against building one,
    // so read this as "the exposure this design has", not as a decision
    // someone weighed and accepted at the time
    function checkSpendCap(): DebateResult | undefined {
      const spend = spendCap.check();
      if (!spend.admitted) {
        logger?.log({
          trace_id,
          stage: 'debate',
          event: 'debate_refused_spend_cap',
          level: 'error',
          message:
            `debate: ${instrument} not started — ${sanitizeLogText(spend.reason ?? 'spend cap')}. ` +
            'No LLM call was made and no debate_log row is written; the tick will short-circuit ' +
            `at Trader with no_trade. ${spendCapRefusalRemedy(spend.kind)} Open ` +
            'positions are unaffected — their bracket legs remain live venue-side, and ' +
            'Execution, reconcile and fill ingestion all keep running.',
          payload: {
            instrument,
            asset_class,
            debate_id,
            spent_usd: spend.spent_usd,
            budget_usd: spend.budget_usd,
            kind: spend.kind,
          },
        });
        return spendCappedDebateResult(debate_id, bar, spend.reason ?? 'spend cap reached');
      }
      return undefined;
    }
    const spendRefusal = checkSpendCap();
    if (spendRefusal !== undefined) {
      return spendRefusal;
    }

    function checkRateLimit(): DebateResult | undefined {
      const reservation = rateLimiter.reserve(
        asset_class,
        worstCaseLlmCallsForAssetClass(asset_class),
      );
      if (!reservation.granted) {
        logger?.log({
          trace_id,
          stage: 'debate',
          event: 'debate_refused_rate_limit',
          level: 'warn',
          message:
            `debate: ${instrument} not started — ${sanitizeLogText(reservation.reason)}. No LLM ` +
            'call was made and no debate_log row is written; the tick will short-circuit at ' +
            'Trader with no_trade. Persistent refusals mean rateLimiterConfig is sized under the ' +
            "universe's real debate rate, not that the market is quiet.",
          payload: { instrument, asset_class, debate_id },
        });
        return rateLimitedDebateResult(debate_id, bar, reservation.reason);
      }
      return undefined;
    }
    const rateLimitRefusal = checkRateLimit();
    if (rateLimitRefusal !== undefined) {
      return rateLimitRefusal;
    }

    // METERING, per call, for the debate just admitted. Wrapped here rather
    // than once at the composition root because the limiter's counters are
    // per-asset-class and `LlmRequest` carries no instrument — this is the
    // innermost layer that still knows which class to bill
    // ROUND CAP, per asset class (#581). Crypto runs ONE round so the debate
    // genuinely fits its latency budget instead of truncating on every tick;
    // stocks keep the 3-round hybrid termination. Given to the personas once
    // and read back off them for `runDebate`, so the final-round check that
    // gates `detectDisagreements` cannot disagree with the loop bound
    const personas = buildDebatePersonas(
      new RateLimitedLlmClient(llmClient, rateLimiter, asset_class),
      trace_id,
      clock,
      debate_id,
      MAX_ROUNDS_BY_ASSET_CLASS[asset_class],
      logger,
    );

    // LATENCY BUDGET (#374). `enforceLatencyBudget` was implemented, tested,
    // exported — and called by nothing, so a pathological debate held the
    // tick, its LLM connections and its rate-limit budget for as long as the
    // provider took. Over an unattended 14-day soak (#238) that has no
    // ceiling at all
    //
    // The budget is per asset class (`LATENCY_BUDGET_MS`: crypto 30s, stocks
    // 60s) and `asset_class` is already on the step's input, so the lookup
    // needs nothing new. The crypto value moved 15s -> 30s alongside the
    // 1-round cap above (#581): 15s was below one measured round, so every
    // crypto debate truncated; #346's arithmetic predicted exactly this
    //
    // `signal` is threaded into `runDebate`, which `throwIfAborted`s before
    // every persona call, so a timed-out debate stops spending instead of
    // running to completion with its answers discarded (#347 built that
    // contract for this call site)
    //
    // A timed-out debate still RESOLVES — partial synthesis when a round
    // completed, low-confidence fallback when none did — so it flows into
    // `persistDebateLog` like any other resolved debate, which is exactly
    // what that function's doc comment already anticipated
    let result: DebateResult;
    try {
      result = await enforceLatencyBudget({
        assetClass: asset_class,
        trace_id,
        debate_id,
        // The same floored read that produced `debate_id`, so a timed-out
        // debate's fallback result names the bar it was taken in (#687)
        bar,
        produceResult: (signal) =>
          runDebate({ views, instrument, bar }, personas, {
            signal,
            maxRounds: personas.maxRounds,
          }),
        getCurrentState: personas.getCurrentState,
        // `JsonDebateLogger` over the step's own sink, so the timeout line
        // lands in the same stream as every other debate line. A step built
        // without a logger (tests) gets a no-op sink rather than an optional
        // logger on `enforceLatencyBudget`, whose contract is that a fired
        // budget is always recorded somewhere
        logger: new JsonDebateLogger(logger ?? { log: () => {} }),
      });
    } catch (cause) {
      const handled = handleDebateFailure(cause);
      if (handled !== undefined) {
        return handled;
      }
      throw cause;
    }

    // The gate refused this debate a permit (#1080). Degrade, do not fault —
    // see `gateRefusedDebateResult`. Returning here also skips
    // `resolvedBarByInstrument.set` below, exactly as the rate-limiter
    // refusal above does: no debate ran, so the bar stays unresolved and a
    // later pass may still run a real one
    function handleDebateFailure(cause: unknown): DebateResult | undefined {
      if (cause instanceof LlmAdmissionRefusedError) {
        logger?.log({
          trace_id,
          stage: 'debate',
          event: 'debate_refused_gate',
          level: 'warn',
          message:
            `debate: ${instrument} not admitted — ${sanitizeLogText(cause.message)}. No ` +
            'debate_log row is written and the tick short-circuits at Trader with no_trade. ' +
            'Persistent refusals mean maxInFlightLlmCalls is sized under the pass width, not ' +
            'that the market is quiet.',
          payload: {
            instrument,
            asset_class,
            debate_id,
            reason: cause.reason,
            queue_depth: cause.queue_depth,
            in_flight: cause.in_flight,
            budget_ms: cause.budget_ms,
            waited_ms: cause.waited_ms,
          },
        });
        // #1533: no `debate_log` row is written for this debate (see the
        // comment above), so `llm_gate_refusals` is the only place a refusal
        // is counted. Recorded in its own try/catch — a bad write here must
        // not turn a degrade-not-fault gate refusal into an unhandled tick
        // failure. `checkLlmFailureRate` is deliberately NOT called here: that
        // guard's rate is over truncated `debate_log` rows and a refusal wrote
        // none, so a refusal moves neither its numerator nor its denominator
        if (gateRefusalRateGuard !== undefined) {
          try {
            gateRefusalRateGuard.gateRefusalSink.recordGateRefusal(clock.now());
          } catch (recordError) {
            logger?.log({
              trace_id,
              stage: 'debate',
              event: 'llm_gate_refusal_record_failed',
              level: 'error',
              message:
                'Failed to record a gate refusal for the gate-refusal-rate guard — this refusal ' +
                'is undercounted in its window',
              payload: { instrument, debate_id, error: describeThrownSafely(recordError) },
            });
          }
          checkGateRefusalRateIfConfigured(gateRefusalRateGuard, logger, clock.now());
        }
        return gateRefusedDebateResult(debate_id, bar, cause.message);
      }
      logDebateFailure({ logger, trace_id, instrument, bar, views, cause });
      return undefined;
    }

    // #435 part 2 — the Debate Engine reads `analyst_weights`, David's
    // resolution on #377
    //
    // AFTER `runDebate`, so `debate_id` keeps meaning what the frozen
    // cross-spec contract says it means: the identity of the debate's INPUTS
    // The spec recorded a collision worry here — same id, different weights,
    // different result — and it is unreachable: weights move only in
    // `runDailyCycle`, the bar is an hour, so a weight step cannot happen
    // inside a bar and two debates sharing an id necessarily ran under
    // identical weights. See `weighted-conviction.ts` for the full argument.
    //
    // The WEIGHTED result is what gets logged, so replay-from-log restores the
    // conviction the Trader actually sized on rather than the pre-weight one
    const weighted =
      analystWeights === undefined
        ? result
        : applyAnalystWeights(result, analystWeights.getAnalystWeights());

    const raced = persistDebateLog({
      store: debateLog,
      result: weighted,
      instrument,
      clock,
      trace_id,
      logger,
    });

    // The bar has RESOLVED — to this run's row, or to the racer's row it lost
    // to (same `debate_id` either way, since a race is by definition the same
    // id). Recorded after the write so a debate that THREW never marks its bar
    // resolved, leaving the crash-retry path open (#743)
    resolvedBarByInstrument.set(instrument, { barMs: bar.getTime(), debate_id });

    // #1396. Fire-and-forget: `checkLlmFailureRate` never throws (it catches
    // and logs its own failures — the window read and the alert POST alike),
    // and the bar is already resolved above. Its synchronous SQLite window
    // read (a small, indexed range scan) still runs inline here, before its
    // first `await`; `void` only keeps the alert POST — the part that could
    // actually be slow — off this tick's critical path
    if (llmFailureRateGuard !== undefined) {
      void checkLlmFailureRate(
        {
          windowSource: llmFailureRateGuard.windowSource,
          monitor: llmFailureRateGuard.monitor,
          alertChannel: llmFailureRateGuard.alertChannel,
          logger,
        },
        clock.now(),
      );
    }

    // #1533. Same fire-and-forget posture, on the success path too so the
    // ratio can FALL — a window read only when a refusal happens can never
    // observe the refusals ageing out, and the monitor's latch would never
    // re-arm
    checkGateRefusalRateIfConfigured(gateRefusalRateGuard, logger, clock.now());

    // Lost the write race: another writer already owns this `debate_id`'s row
    // Return THEIR row, so the Trader sizes on the same bytes the Feedback Loop
    // will later attribute the trade to. Without this the backstop reproduced
    // #617's defect in miniature — the duplicate write was skipped, but the
    // loser still handed its own discarded sample to the Trader
    //
    // A raced row that is not fully replayable falls back to the fresh result:
    // an incomplete row is not a better answer than a complete one, and the
    // mismatch it would leave is the lesser of the two problems
    if (isReplayable(raced)) {
      return replayedDebateResult(raced);
    }

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
    event: 'debate_unresolved',
    level: 'error',
    message:
      `debate: ${instrument} failed before resolving — no debate_log row is written for a ` +
      'debate that produced no result (the write-once debate_id stays free for the re-run): ' +
      sanitizeLogText(describeThrownSafely(cause)),
    payload: { instrument, debate_id: computeDebateId(instrument, bar, views) },
  });
}
