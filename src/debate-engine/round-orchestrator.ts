/**
 * Round Structure & Termination Orchestrator (#34) — the core loop that drives
 * a debate to convergence or the hard cap. See docs/specs/debate-engine-spec.md
 * ("Module: Round Structure & Termination").
 *
 * Round format (every round): bull -> bear -> mediator. Hybrid termination —
 * the mediator evaluates after each round whether material disagreement
 * remains; convergence terminates early, otherwise a hard 3-round cap forces
 * termination.
 *
 * Scope boundary: this orchestrator owns the loop, termination, and
 * `DebateResult` assembly only. The Bull/Bear/Mediator personas (#26), the
 * mediator's semantic convergence judgement (#32), latency-budget enforcement
 * and conviction scoring (#33) are NOT implemented here — they are injected
 * through the ports below, the same "explicit local seam ahead of the blocked
 * dependency" pattern analyst-contribution.ts (#36) and llm/types.ts use. The
 * mediator's per-round `converged` flag is an INPUT the orchestrator reads,
 * not something it computes.
 */
import type { Clock } from '../shared/index.js';
import type { AnalystRoundStance } from './analyst-contribution.js';
import { buildAnalystContributions } from './analyst-contribution.js';
import { computeDebateId } from './debate-id.js';
import type { AnalystView, DebateResult, Direction } from './types.js';

/** Hard cap on debate rounds (spec: "hard cap of 3 rounds maximum"). */
export const MAX_ROUNDS = 3;

/**
 * State handed to each persona for the round it is speaking in. `views` is the
 * upstream analyst input (constant across the debate); `round` is 1-indexed;
 * `priorArguments` are the free-text arguments produced so far this debate, in
 * order, so bear can rebut bull and the mediator can weigh both.
 */
export interface RoundContext {
  views: AnalystView[];
  round: number;
  priorArguments: DebateArgument[];
  /**
   * Cancels this round's work (#347). Carried on the context rather than added
   * to `DebaterPersona.argue`/`MediatorPersona.assess` as a parameter, so the
   * two port interfaces — and every fake implementing them — are unchanged: a
   * persona that wants to be cancellable reads `context.signal` and forwards
   * it to its LLM client; one that ignores it still compiles and still runs.
   */
  signal?: AbortSignal | undefined;
}

/** One persona's contribution to a single round. */
export interface DebateArgument {
  persona: 'bull' | 'bear';
  round: number;
  /** Free-text argument this persona made this round. */
  argument: string;
}

/**
 * Bull/Bear port (#26). Given the round context, produces this round's
 * argument. The orchestrator does not interpret the prose — it threads it into
 * `priorArguments` for downstream personas and the mediator.
 */
export interface DebaterPersona {
  argue(context: RoundContext): Promise<DebateArgument>;
}

/**
 * The mediator's assessment at the end of a round (#26/#32). `converged`
 * signals whether material disagreement has been resolved; `synthesis` is the
 * full, always-actionable output (spec: mediator "produces a full synthesis...
 * regardless of convergence status"). `stances` is each analyst's stance as
 * read through the debate lens this round, fed to buildAnalystContributions.
 */
export interface MediatorAssessment {
  converged: boolean;
  synthesis: MediatorSynthesis;
  stances: RoundStance[];
}

/** One analyst's debate-lens stance in a given round (round supplied by the orchestrator). */
export interface RoundStance {
  analyst_id: string;
  stance: Direction;
}

/**
 * The mediator's synthesis — the fields the Trader-facing `DebateResult`
 * carries that only the mediator can produce. Conviction scoring (#33) lives
 * behind `confidence`; the orchestrator does not compute it.
 */
export interface MediatorSynthesis {
  synthesis: string;
  position: string;
  confidence: number;
  direction: Direction;
  disagreement_summary: string;
  /** Unresolved disagreements; empty when converged. */
  open_items: string[];
}

/** Mediator port (#26): assesses convergence and synthesizes after each round. */
export interface MediatorPersona {
  assess(context: RoundContext): Promise<MediatorAssessment>;
}

/** Personas + clock injected into a debate run. */
export interface DebatePersonas {
  bull: DebaterPersona;
  bear: DebaterPersona;
  mediator: MediatorPersona;
  clock: Clock;
}

/** Everything a debate needs beyond the personas: the analyst input and its provenance keys. */
export interface DebateInput {
  views: AnalystView[];
  /** Instrument symbol, part of the deterministic debate_id. */
  instrument: string;
  /** Bar timestamp, part of the deterministic debate_id. */
  bar: Date;
}

/** Per-run knobs that are not debate INPUT (nothing here is hashed into `debate_id`). */
export interface RunDebateOptions {
  /**
   * Round cap for THIS debate, defaulting to `MAX_ROUNDS` (#581). An integer in
   * `[1, MAX_ROUNDS]`: the ceiling stays the spec's hard cap — this knob only
   * shrinks a debate (crypto runs one round so it fits its latency budget), it
   * cannot grow one past the safety cap. Not hashed into `debate_id`, same as
   * `signal`: two debates over identical inputs are the same debate regardless
   * of how many rounds they were allowed.
   */
  maxRounds?: number | undefined;
  /**
   * Cancels the debate (#347). Checked before EVERY persona call and threaded
   * into each `RoundContext`, so an aborted debate issues no further LLM calls
   * — belt (the loop refuses to start the next call) and braces (the client
   * aborts the one already in flight). The check is what makes the guarantee
   * hold even for an `LlmClient` that ignores `LlmRequest.signal`.
   *
   * `throwIfAborted` rather than a quiet `break`: a cancelled debate has no
   * result worth returning, and the one caller that cancels
   * (`enforceLatencyBudget`) has already produced its fallback and is no
   * longer listening. Returning a truncated `DebateResult` here would instead
   * race that fallback and risk a second, contradictory result reaching the
   * Trader.
   */
  signal?: AbortSignal | undefined;
}

/**
 * Runs the round-robin debate to convergence or the hard cap and returns the
 * compact Trader-facing `DebateResult`. The ephemeral round-by-round state is
 * not returned (spec: compact payload, no transcript; no persistence).
 */
export async function runDebate(
  input: DebateInput,
  personas: DebatePersonas,
  options: RunDebateOptions = {},
): Promise<DebateResult> {
  const { views, instrument, bar } = input;
  const { bull, bear, mediator, clock } = personas;
  const { signal } = options;

  const maxRounds = options.maxRounds ?? MAX_ROUNDS;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS) {
    throw new Error(
      `runDebate: maxRounds must be an integer in [1, ${MAX_ROUNDS}] (got ${maxRounds})`,
    );
  }

  const startedAt = clock.now().getTime();
  const priorArguments: DebateArgument[] = [];
  const roundStances: AnalystRoundStance[] = [];

  let roundsCompleted = 0;
  let lastAssessment: MediatorAssessment | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    signal?.throwIfAborted();
    const bullContext: RoundContext = { views, round, priorArguments, signal };
    priorArguments.push(await bull.argue(bullContext));

    signal?.throwIfAborted();
    const bearContext: RoundContext = { views, round, priorArguments, signal };
    priorArguments.push(await bear.argue(bearContext));

    signal?.throwIfAborted();
    const mediatorContext: RoundContext = { views, round, priorArguments, signal };
    const assessment = await mediator.assess(mediatorContext);

    roundsCompleted = round;
    lastAssessment = assessment;
    for (const stance of assessment.stances) {
      roundStances.push({ analyst_id: stance.analyst_id, round, stance: stance.stance });
    }

    if (assessment.converged) {
      break;
    }
  }

  // Loop always runs at least once, so lastAssessment is defined; this guards
  // the impossible empty-loop case for the type-checker and any future caller
  // that lowers MAX_ROUNDS to 0.
  if (lastAssessment === undefined) {
    throw new Error('runDebate: debate produced no mediator assessment');
  }

  const converged = lastAssessment.converged;
  const synthesis = lastAssessment.synthesis;

  // Invariant (AC + spec): a hard-cap termination without convergence must
  // report converged=false AND a non-empty open_items so downstream (Trader,
  // Risk) can apply caution. The orchestrator owns this rather than trusting
  // the mediator port — if the mediator hands back empty open_items on a
  // non-converged cap, fall back to the disagreement summary.
  const openItems =
    !converged && synthesis.open_items.length === 0
      ? [synthesis.disagreement_summary]
      : synthesis.open_items;

  return {
    synthesis: synthesis.synthesis,
    position: synthesis.position,
    confidence: synthesis.confidence,
    contributions: buildAnalystContributions(views, roundStances),
    disagreement_summary: synthesis.disagreement_summary,
    open_items: openItems,
    converged,
    rounds_completed: roundsCompleted,
    latency_ms: clock.now().getTime() - startedAt,
    direction: synthesis.direction,
    debate_id: computeDebateId(instrument, bar, views),
  };
}
