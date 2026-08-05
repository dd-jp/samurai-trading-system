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
} from '../../debate-engine/index.js';
import {
  buildDebateLog,
  computeConvictionScore,
  computeDebateId,
  type DebatePersonas,
  type DebaterPersona,
  detectDisagreements,
  MAX_ROUNDS,
  type MediatorAssessment,
  type MediatorPersona,
  type PersonaResponse,
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
): DebatePersonas {
  let lastBull: PersonaResponse | undefined;
  let lastBear: PersonaResponse | undefined;
  const accumulatedStances: AnalystRoundStance[] = [];

  const bull: DebaterPersona = {
    async argue(context) {
      const response = await runBullPersona(llmClient, {
        trace_id,
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
        ? await detectDisagreements(context.views, llmClient, context.signal)
        : { summary: '', conflicts: [], method: 'directional_fallback' as const };

      const confidence = computeConvictionScore(context.views, accumulatedStances);

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

  return { bull, bear, mediator, clock };
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

  store.writeLog(buildDebateLog(result, instrument, bar, clock.now()));
}

export function buildDebateStep(
  llmClient: LlmClient,
  /**
   * Required, not optional: #364 was a store that existed, was constructed,
   * and had no caller. An optional dependency here would let the production
   * composition root silently drop it again.
   */
  debateLog: DebateLogStore,
  logger?: Logger,
): TickSteps['debate'] {
  return async ({ trace_id, instrument, views, clock }) => {
    const personas = buildDebatePersonas(llmClient, trace_id, clock);
    // Hoisted out of the `runDebate` call: the SAME `Date` must go into
    // `debate_id`'s hash and into the row's `bar_timestamp`, or the row
    // claims a bar coordinate its own primary key does not encode.
    const bar = clock.now();

    let result: DebateResult;
    try {
      result = await runDebate({ views, instrument, bar }, personas);
    } catch (cause) {
      logDebateFailure({ logger, trace_id, instrument, bar, views, cause });
      throw cause;
    }

    persistDebateLog({ store: debateLog, result, instrument, bar, clock, trace_id, logger });
    return result;
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
