import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import {
  buildApiError,
  NousApiError,
  type NousGateOptions,
  NousRefusalError,
  NousTruncatedError,
  type NousWireUsage,
  normaliseUsage,
  parseNousJsonBody,
  resolveMeteredModel,
  truncateForError,
  withNousGateSlot,
} from './nous-wire.js';
import type { AnthropicUsage } from './pricing.js';

export { NousApiError, NousRefusalError, NousTruncatedError } from './nous-wire.js';

interface NousChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface NousChatRequest {
  model: string;
  messages: readonly NousChatMessage[];
  max_tokens: number;
}

export interface NousChatResult {
  text: string;
  usage: AnthropicUsage;
  server_tool_calls?: number;
  model: string;
  upstream_model: string | undefined;
  finish_reason: string | null;
  ttfb_ms: number;
}

export interface NousChatOptions extends NousGateOptions {
  apiKey: string;
  baseUrl: string;
}

interface NousChoice {
  message?: { content?: unknown; refusal?: unknown };
  finish_reason?: unknown;
}

interface NousResponseBody {
  choices?: NousChoice[];
  model?: unknown;
  usage?: NousWireUsage;
}

export async function nousChat(
  options: NousChatOptions,
  request: NousChatRequest,
): Promise<NousChatResult> {
  return withNousGateSlot(options, (timeoutMs) => dispatch(options, request, timeoutMs));
}

interface ChoiceReading {
  readonly text: string;
  readonly finish_reason: string | null;
  readonly refusal: string;
}

async function post(
  options: NousChatOptions,
  request: NousChatRequest,
  timeoutMs: number,
): Promise<{ response: Response; ttfb_ms: number }> {
  const dispatchedAt = Date.now();
  const response = await fetchWithTimeout(
    `${options.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.max_tokens,
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    timeoutMs,
  );
  return { response, ttfb_ms: Date.now() - dispatchedAt };
}

function firstChoiceOrThrow(parsed: NousResponseBody, status: number): NousChoice {
  const choice = parsed.choices?.[0];
  if (choice !== undefined) return choice;
  throw new NousApiError(
    status,
    `Nous API error: response body missing expected "choices" array (${truncateForError(
      JSON.stringify(parsed),
    )})`,
    parsed,
  );
}

function readChoice(choice: NousChoice): ChoiceReading {
  const content = choice.message?.content;
  const refusal = choice.message?.refusal;
  return {
    text: typeof content === 'string' ? content : '',
    finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    refusal: typeof refusal === 'string' ? refusal : '',
  };
}

function wireFailureOf(
  request: NousChatRequest,
  reading: ChoiceReading,
  usage: AnthropicUsage,
): Error | undefined {
  if (reading.finish_reason === 'length') {
    return new NousTruncatedError(request.model, request.max_tokens, usage);
  }
  const contentFiltered = reading.finish_reason === 'content_filter';
  if (!contentFiltered && reading.refusal.trim() === '') return undefined;
  return new NousRefusalError(
    request.model,
    contentFiltered ? 'finish_reason="content_filter"' : 'message.refusal',
    usage,
    reading.refusal === '' ? undefined : reading.refusal,
  );
}

async function dispatch(
  options: NousChatOptions,
  request: NousChatRequest,
  timeoutMs: number,
): Promise<NousChatResult> {
  const { response, ttfb_ms } = await post(options, request, timeoutMs);
  if (!response.ok) throw await buildApiError(response);
  const parsed = (await parseNousJsonBody(response)) as NousResponseBody;
  const reading = readChoice(firstChoiceOrThrow(parsed, response.status));
  const usage = normaliseUsage(parsed.usage);
  const wireFailure = wireFailureOf(request, reading, usage);
  if (wireFailure !== undefined) throw wireFailure;
  return {
    text: reading.text,
    usage,
    model: resolveMeteredModel(parsed.model, request.model),
    upstream_model: typeof parsed.model === 'string' ? parsed.model : undefined,
    finish_reason: reading.finish_reason,
    ttfb_ms,
  };
}
