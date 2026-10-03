import { hashPromptTemplate } from '../llm/index.js';
import { BARE_JSON_INSTRUCTION, unwrapFencedJson } from './llm/json-response.js';
import { wrapUntrusted } from './llm/prompt-safety.js';
import type { LlmClient, LlmRequestContext } from './llm/types.js';
import type { AnalystView, Direction } from './types.js';

const DIRECTIONS: Direction[] = ['bullish', 'bearish', 'neutral'];

function isDirection(value: unknown): value is Direction {
  return typeof value === 'string' && (DIRECTIONS as string[]).includes(value);
}

export interface PersonaResponse {
  stance: Direction;
  rationale: string;
}

export interface MediatorResponse extends PersonaResponse {
  converged: boolean;
}

export interface PersonaInput {
  trace_id: string;
  debate_id?: string | undefined;
  analyst_views: AnalystView[];
  debate_state?: Record<string, unknown>;
  signal?: AbortSignal | undefined;
}

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
    parsed = JSON.parse(unwrapFencedJson(rawText));
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
    parsed = JSON.parse(unwrapFencedJson(rawText));
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

function renderAnalystViews(views: AnalystView[]): string {
  const rendered = views
    .map(
      (view) =>
        `- [${view.analyst_type}/${view.analyst_id}] ${view.direction} (confidence ${view.confidence}): ${view.key_points.join('; ')}`,
    )
    .join('\n');
  return wrapUntrusted(rendered);
}

function buildContext(input: PersonaInput, templateHash: string): LlmRequestContext {
  const base: LlmRequestContext = {
    analyst_views: input.analyst_views,
    attribution: {
      trace_id: input.trace_id,
      stage: 'debate',
      debate_id: input.debate_id,
      prompt_template_hash: templateHash,
    },
  };
  if (input.debate_state !== undefined) {
    base.debate_state = input.debate_state;
  }
  return base;
}

const BULL_PROMPT_TEMPLATE = [
  'You are the Bull persona in a trading debate. Argue for the optimistic',
  'interpretation of the following analyst views, emphasizing positive',
  'signals and opportunities. Respond as JSON: {"stance": "bullish"|"bearish"|"neutral", "rationale": string}.',
  BARE_JSON_INSTRUCTION,
].join('\n');
const BULL_PROMPT_TEMPLATE_HASH = hashPromptTemplate(BULL_PROMPT_TEMPLATE);

export async function runBullPersona(
  client: LlmClient,
  input: PersonaInput,
): Promise<PersonaResponse> {
  const prompt = [BULL_PROMPT_TEMPLATE, '', renderAnalystViews(input.analyst_views)].join('\n');

  const response = await client.complete<PersonaResponse>({
    prompt,
    context: buildContext(input, BULL_PROMPT_TEMPLATE_HASH),
    parseResponse: parsePersonaResponse,
    signal: input.signal,
  });
  return response.data;
}

const BEAR_PROMPT_TEMPLATE = [
  'You are the Bear persona in a trading debate. Argue for the pessimistic',
  'interpretation of the following analyst views, emphasizing risks and',
  'downside. Respond as JSON: {"stance": "bullish"|"bearish"|"neutral", "rationale": string}.',
  BARE_JSON_INSTRUCTION,
].join('\n');
const BEAR_PROMPT_TEMPLATE_HASH = hashPromptTemplate(BEAR_PROMPT_TEMPLATE);

export async function runBearPersona(
  client: LlmClient,
  input: PersonaInput,
): Promise<PersonaResponse> {
  const prompt = [BEAR_PROMPT_TEMPLATE, '', renderAnalystViews(input.analyst_views)].join('\n');

  const response = await client.complete<PersonaResponse>({
    prompt,
    context: buildContext(input, BEAR_PROMPT_TEMPLATE_HASH),
    parseResponse: parsePersonaResponse,
    signal: input.signal,
  });
  return response.data;
}

const MEDIATOR_PROMPT_TEMPLATE = [
  'You are the Mediator persona in a trading debate. Arbitrate between the',
  'Bull and Bear arguments below, evaluate whether material disagreement',
  'remains, and signal convergence if the debate can terminate. Respond as',
  'JSON: {"stance": "bullish"|"bearish"|"neutral", "rationale": string, "converged": boolean}.',
  BARE_JSON_INSTRUCTION,
].join('\n');
const MEDIATOR_PROMPT_TEMPLATE_HASH = hashPromptTemplate(MEDIATOR_PROMPT_TEMPLATE);

export async function runMediatorPersona(
  client: LlmClient,
  input: MediatorInput,
): Promise<MediatorResponse> {
  const bullBearBlock = [
    `Bull (${input.bullResponse.stance}): ${input.bullResponse.rationale}`,
    `Bear (${input.bearResponse.stance}): ${input.bearResponse.rationale}`,
  ].join('\n');

  const prompt = [
    MEDIATOR_PROMPT_TEMPLATE,
    '',
    wrapUntrusted(bullBearBlock),
    '',
    'Underlying analyst views:',
    renderAnalystViews(input.analyst_views),
  ].join('\n');

  const response = await client.complete<MediatorResponse>({
    prompt,
    context: buildContext(input, MEDIATOR_PROMPT_TEMPLATE_HASH),
    parseResponse: parseMediatorResponse,
    signal: input.signal,
  });
  return response.data;
}
