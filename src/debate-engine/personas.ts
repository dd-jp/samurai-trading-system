/**
 * Debater personas (#26) — see docs/specs/debate-engine-spec.md "Debater
 * Personas": Bull, Bear, and Mediator debate the AnalystViews rather than
 * producing raw analysis. Distinct from upstream Analysts.
 *
 * Each persona is a plain function over `LlmClient` (same shape as the
 * client itself expects via `LlmRequest.parseResponse`), so they can be
 * invoked independently without any shared orchestrator — round structure
 * and termination (#34) build on top of these, not the other way around.
 */

import type { LlmClient, LlmRequestContext } from './llm/types.js';
import type { AnalystView, Direction } from './types.js';

const DIRECTIONS: Direction[] = ['bullish', 'bearish', 'neutral'];

function isDirection(value: unknown): value is Direction {
  return typeof value === 'string' && (DIRECTIONS as string[]).includes(value);
}

/** Structured output every persona returns (spec: "stance + rationale"). */
export interface PersonaResponse {
  stance: Direction;
  rationale: string;
}

/** Mediator's output additionally signals convergence (spec's hybrid termination). */
export interface MediatorResponse extends PersonaResponse {
  converged: boolean;
}

/** What every persona needs: the analyst views under debate, plus tracing/state context. */
export interface PersonaInput {
  trace_id: string;
  analyst_views: AnalystView[];
  debate_state?: Record<string, unknown>;
}

/** Additional input the mediator arbitrates over (spec: "arbitrates between bull and bear"). */
export interface MediatorInput extends PersonaInput {
  bullResponse: PersonaResponse;
  bearResponse: PersonaResponse;
}

function isPersonaResponse(candidate: unknown): candidate is PersonaResponse {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const response = candidate as Partial<PersonaResponse>;
  return isDirection(response.stance) && typeof response.rationale === 'string';
}

function isMediatorResponse(candidate: unknown): candidate is MediatorResponse {
  return (
    isPersonaResponse(candidate) &&
    typeof (candidate as Partial<MediatorResponse>).converged === 'boolean'
  );
}

function parsePersonaResponse(
  rawText: string,
): { valid: true; data: PersonaResponse } | { valid: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { valid: false, reason: 'malformed persona response: not valid JSON' };
  }
  if (!isPersonaResponse(parsed)) {
    return {
      valid: false,
      reason: 'malformed persona response: missing or invalid stance/rationale',
    };
  }
  return { valid: true, data: parsed };
}

function parseMediatorResponse(
  rawText: string,
): { valid: true; data: MediatorResponse } | { valid: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { valid: false, reason: 'malformed mediator response: not valid JSON' };
  }
  if (!isMediatorResponse(parsed)) {
    return {
      valid: false,
      reason: 'malformed mediator response: missing or invalid stance/rationale/converged',
    };
  }
  return { valid: true, data: parsed };
}

/** Renders AnalystViews into a compact text block shared by all persona prompts. */
function renderAnalystViews(views: AnalystView[]): string {
  return views
    .map(
      (view) =>
        `- [${view.analyst_type}/${view.analyst_id}] ${view.direction} (confidence ${view.confidence}): ${view.key_points.join('; ')}`,
    )
    .join('\n');
}

function buildContext(input: PersonaInput): LlmRequestContext {
  return input.debate_state === undefined
    ? { analyst_views: input.analyst_views }
    : { analyst_views: input.analyst_views, debate_state: input.debate_state };
}

/** Bull persona: argues for optimistic interpretation, emphasizes positive signals. */
export async function runBullPersona(
  client: LlmClient,
  input: PersonaInput,
): Promise<PersonaResponse> {
  const prompt = [
    'You are the Bull persona in a trading debate. Argue for the optimistic',
    'interpretation of the following analyst views, emphasizing positive',
    'signals and opportunities. Respond as JSON: {"stance": "bullish"|"bearish"|"neutral", "rationale": string}.',
    '',
    renderAnalystViews(input.analyst_views),
  ].join('\n');

  const response = await client.complete<PersonaResponse>({
    prompt,
    context: buildContext(input),
    parseResponse: parsePersonaResponse,
  });
  return response.data;
}

/** Bear persona: argues for pessimistic interpretation, emphasizes risks and downside. */
export async function runBearPersona(
  client: LlmClient,
  input: PersonaInput,
): Promise<PersonaResponse> {
  const prompt = [
    'You are the Bear persona in a trading debate. Argue for the pessimistic',
    'interpretation of the following analyst views, emphasizing risks and',
    'downside. Respond as JSON: {"stance": "bullish"|"bearish"|"neutral", "rationale": string}.',
    '',
    renderAnalystViews(input.analyst_views),
  ].join('\n');

  const response = await client.complete<PersonaResponse>({
    prompt,
    context: buildContext(input),
    parseResponse: parsePersonaResponse,
  });
  return response.data;
}

/**
 * Mediator persona: arbitrates between Bull and Bear, evaluates whether
 * material disagreement remains, and signals convergence (spec story 8).
 */
export async function runMediatorPersona(
  client: LlmClient,
  input: MediatorInput,
): Promise<MediatorResponse> {
  const prompt = [
    'You are the Mediator persona in a trading debate. Arbitrate between the',
    'Bull and Bear arguments below, evaluate whether material disagreement',
    'remains, and signal convergence if the debate can terminate. Respond as',
    'JSON: {"stance": "bullish"|"bearish"|"neutral", "rationale": string, "converged": boolean}.',
    '',
    `Bull (${input.bullResponse.stance}): ${input.bullResponse.rationale}`,
    `Bear (${input.bearResponse.stance}): ${input.bearResponse.rationale}`,
    '',
    'Underlying analyst views:',
    renderAnalystViews(input.analyst_views),
  ].join('\n');

  const response = await client.complete<MediatorResponse>({
    prompt,
    context: buildContext(input),
    parseResponse: parseMediatorResponse,
  });
  return response.data;
}
