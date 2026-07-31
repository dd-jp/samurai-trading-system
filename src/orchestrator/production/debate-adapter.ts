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
 */
import type { AnalystRoundStance, LlmClient } from '../../debate-engine/index.js';
import {
  computeConvictionScore,
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
import type { Clock } from '../../shared/index.js';
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
        ? await detectDisagreements(context.views, llmClient)
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

export function buildDebateStep(llmClient: LlmClient): TickSteps['debate'] {
  return async ({ trace_id, instrument, views, clock }) => {
    const personas = buildDebatePersonas(llmClient, trace_id, clock);
    return runDebate({ views, instrument, bar: clock.now() }, personas);
  };
}
