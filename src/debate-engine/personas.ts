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

import { BARE_JSON_INSTRUCTION, unwrapFencedJson } from './llm/json-response.js';
import { wrapUntrusted } from './llm/prompt-safety.js';
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
  /**
   * The debate this persona call belongs to (#326) — forwarded to the spend
   * meter so every call a debate makes is attributable to that decision.
   * Optional because a persona is callable standalone (that is the point of
   * personas.ts being plain functions), in which case the call meters as
   * unattributed rather than being refused.
   */
  debate_id?: string | undefined;
  analyst_views: AnalystView[];
  debate_state?: Record<string, unknown>;
  /**
   * Cancels this persona's LLM call (#347). Forwarded verbatim to
   * `LlmClient.complete`; the persona itself has no cancellation logic of its
   * own, it is only a link in the chain from the debate's latency budget down
   * to `fetch`.
   */
  signal?: AbortSignal | undefined;
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
    // `unwrapFencedJson` (#361) tolerates exactly one shape the pinned model
    // emits on every call — a markdown code fence around the object. It is
    // not a prose extractor: a refusal, a preamble, or a truncated response
    // is handed through untouched and still fails here.
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

/**
 * Renders AnalystViews into a compact text block shared by all persona
 * prompts. `key_points` is ingested free text (ultimately traced back to
 * news/sentiment ingestion) and untrustworthy as instruction content, so the
 * rendered block is passed through `wrapUntrusted` (#208, prompt-safety.ts)
 * rather than concatenated bare into the prompt.
 */
function renderAnalystViews(views: AnalystView[]): string {
  const rendered = views
    .map(
      (view) =>
        `- [${view.analyst_type}/${view.analyst_id}] ${view.direction} (confidence ${view.confidence}): ${view.key_points.join('; ')}`,
    )
    .join('\n');
  return wrapUntrusted(rendered);
}

/**
 * Attribution rides along in `context.attribution` (#326) so the spend meter
 * can bill each persona call to the debate that issued it. That envelope never
 * reaches the prompt (`anthropic-client.ts:promptContextOf`), so a persona's
 * model input is byte-for-byte what it was before this existed.
 */
function buildContext(input: PersonaInput): LlmRequestContext {
  const base: LlmRequestContext = {
    analyst_views: input.analyst_views,
    attribution: { trace_id: input.trace_id, stage: 'debate', debate_id: input.debate_id },
  };
  if (input.debate_state !== undefined) {
    base.debate_state = input.debate_state;
  }
  return base;
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
    BARE_JSON_INSTRUCTION,
    '',
    renderAnalystViews(input.analyst_views),
  ].join('\n');

  const response = await client.complete<PersonaResponse>({
    prompt,
    context: buildContext(input),
    parseResponse: parsePersonaResponse,
    signal: input.signal,
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
    BARE_JSON_INSTRUCTION,
    '',
    renderAnalystViews(input.analyst_views),
  ].join('\n');

  const response = await client.complete<PersonaResponse>({
    prompt,
    context: buildContext(input),
    parseResponse: parsePersonaResponse,
    signal: input.signal,
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
  const bullBearBlock = [
    `Bull (${input.bullResponse.stance}): ${input.bullResponse.rationale}`,
    `Bear (${input.bearResponse.stance}): ${input.bearResponse.rationale}`,
  ].join('\n');

  const prompt = [
    'You are the Mediator persona in a trading debate. Arbitrate between the',
    'Bull and Bear arguments below, evaluate whether material disagreement',
    'remains, and signal convergence if the debate can terminate. Respond as',
    'JSON: {"stance": "bullish"|"bearish"|"neutral", "rationale": string, "converged": boolean}.',
    BARE_JSON_INSTRUCTION,
    '',
    wrapUntrusted(bullBearBlock),
    '',
    'Underlying analyst views:',
    renderAnalystViews(input.analyst_views),
  ].join('\n');

  const response = await client.complete<MediatorResponse>({
    prompt,
    context: buildContext(input),
    parseResponse: parseMediatorResponse,
    signal: input.signal,
  });
  return response.data;
}
