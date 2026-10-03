import type { Clock } from '../../shared/index.js';
import type { AnalystRoundStance } from './analyst-contribution.js';
import { buildAnalystContributions } from './analyst-contribution.js';
import { computeDebateId } from './debate-id.js';
import type { AnalystView, DebateResult, Direction, RoundVerdict } from './types.js';

export const MAX_ROUNDS = 3;

export interface RoundContext {
  views: AnalystView[];
  round: number;
  priorArguments: DebateArgument[];
  signal?: AbortSignal | undefined;
}

interface DebateArgument {
  persona: 'bull' | 'bear';
  round: number;
  argument: string;
}

export interface DebaterPersona {
  argue(context: RoundContext): Promise<DebateArgument>;
}

export interface MediatorAssessment {
  converged: boolean;
  synthesis: MediatorSynthesis;
  stances: RoundStance[];
}

export interface RoundStance {
  analyst_id: string;
  stance: Direction;
}

export interface MediatorSynthesis {
  synthesis: string;
  position: string;
  confidence: number;
  direction: Direction;
  disagreement_summary: string;
  open_items: string[];
}

export interface MediatorPersona {
  assess(context: RoundContext): Promise<MediatorAssessment>;
}

export interface DebatePersonas {
  bull: DebaterPersona;
  bear: DebaterPersona;
  mediator: MediatorPersona;
  clock: Clock;
}

export interface DebateInput {
  views: AnalystView[];
  instrument: string;
  bar: Date;
}

export interface RunDebateOptions {
  maxRounds?: number | undefined;
  signal?: AbortSignal | undefined;
}

function resolveMaxRounds(requested: number | undefined): number {
  const maxRounds = requested ?? MAX_ROUNDS;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS) {
    throw new Error(
      `runDebate: maxRounds must be an integer in [1, ${MAX_ROUNDS}] (got ${maxRounds})`,
    );
  }
  return maxRounds;
}

async function argueRound(
  personas: DebatePersonas,
  views: AnalystView[],
  round: number,
  priorArguments: DebateArgument[],
  signal: AbortSignal | undefined,
): Promise<MediatorAssessment> {
  signal?.throwIfAborted();
  const bullContext: RoundContext = { views, round, priorArguments, signal };
  priorArguments.push(await personas.bull.argue(bullContext));

  signal?.throwIfAborted();
  const bearContext: RoundContext = { views, round, priorArguments, signal };
  priorArguments.push(await personas.bear.argue(bearContext));

  signal?.throwIfAborted();
  const mediatorContext: RoundContext = { views, round, priorArguments, signal };
  return personas.mediator.assess(mediatorContext);
}

function openItemsOf(converged: boolean, synthesis: MediatorSynthesis): string[] {
  return !converged && synthesis.open_items.length === 0
    ? [synthesis.disagreement_summary]
    : synthesis.open_items;
}

export async function runDebate(
  input: DebateInput,
  personas: DebatePersonas,
  options: RunDebateOptions = {},
): Promise<DebateResult> {
  const { views, instrument, bar } = input;
  const { clock } = personas;
  const { signal } = options;

  const maxRounds = resolveMaxRounds(options.maxRounds);

  const startedAt = clock.now().getTime();
  const priorArguments: DebateArgument[] = [];
  const roundStances: AnalystRoundStance[] = [];

  let roundsCompleted = 0;
  let lastAssessment: MediatorAssessment | undefined;
  const roundVerdicts: RoundVerdict[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const assessment = await argueRound(personas, views, round, priorArguments, signal);

    roundsCompleted = round;
    lastAssessment = assessment;
    for (const stance of assessment.stances) {
      roundStances.push({ analyst_id: stance.analyst_id, round, stance: stance.stance });
    }
    roundVerdicts.push({
      round,
      direction: assessment.synthesis.direction,
      confidence: assessment.synthesis.confidence,
    });

    if (assessment.converged) {
      break;
    }
  }

  if (lastAssessment === undefined) {
    throw new Error('runDebate: debate produced no mediator assessment');
  }

  const converged = lastAssessment.converged;
  const synthesis = lastAssessment.synthesis;

  return {
    synthesis: synthesis.synthesis,
    position: synthesis.position,
    confidence: synthesis.confidence,
    contributions: buildAnalystContributions(views, roundStances),
    disagreement_summary: synthesis.disagreement_summary,
    open_items: openItemsOf(converged, synthesis),
    converged,
    rounds_completed: roundsCompleted,
    latency_ms: clock.now().getTime() - startedAt,
    direction: synthesis.direction,
    round_verdicts: roundVerdicts,
    debate_id: computeDebateId(instrument, bar, views),
    bar_timestamp: bar,
    read: true,
  };
}
