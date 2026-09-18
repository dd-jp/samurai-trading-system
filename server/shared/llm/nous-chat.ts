
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import type { LlmInFlightGate } from './in-flight-gate.js';
import {
  buildApiError,
  clampTimeoutToBudget,
  DEFAULT_NOUS_TIMEOUT_MS,
  NousApiError,
  NousRefusalError,
  NousTruncatedError,
  type NousWireUsage,
  normaliseUsage,
  resolveMeteredModel,
  truncateForError,
} from './nous-wire.js';
import type { AnthropicUsage } from './pricing.js';

export {
  DEFAULT_NOUS_TIMEOUT_MS,
  NousApiError,
  NousRefusalError,
  NousTruncatedError,
} from './nous-wire.js';

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
  finish_reason: string | null;
  ttfb_ms: number;
}

export interface NousChatOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
  gate: LlmInFlightGate;
  gateBudgetMs?: number | undefined;
  expectedCallMs?: number | undefined;
  llmStage?: string | undefined;
  clampCallToBudget?: boolean | undefined;
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
  const enteredAt = Date.now();
  const slot = await options.gate.acquire({
    budgetMs: options.gateBudgetMs,
    expectedCallMs: options.expectedCallMs,
    signal: options.signal,
    llmStage: options.llmStage,
  });
  try {
    const configuredTimeoutMs = options.timeoutMs ?? DEFAULT_NOUS_TIMEOUT_MS;
    const timeoutMs =
      options.clampCallToBudget === true
        ? clampTimeoutToBudget(configuredTimeoutMs, options.gateBudgetMs, Date.now() - enteredAt)
        : configuredTimeoutMs;
    return await dispatch(options, request, timeoutMs);
  } finally {
    slot.release();
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a flat sequence of independent response-shape guards translating one wire failure (bad JSON, missing choices, truncation, refusal) at a time into a typed error; splitting the checks apart would scatter this one wire contract across several functions.
async function dispatch(
  options: NousChatOptions,
  request: NousChatRequest,
  timeoutMs: number,
): Promise<NousChatResult> {
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
  const ttfb_ms = Date.now() - dispatchedAt;

  if (!response.ok) {
    throw await buildApiError(response);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new NousApiError(
      response.status,
      `Nous API error: response body could not be parsed as JSON (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    );
  }

  const parsed = body as NousResponseBody;
  const choice = parsed.choices?.[0];
  if (choice === undefined) {
    throw new NousApiError(
      response.status,
      `Nous API error: response body missing expected "choices" array (${truncateForError(
        JSON.stringify(body),
      )})`,
      body,
    );
  }

  const usage = normaliseUsage(parsed.usage);
  const finish_reason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;

  if (finish_reason === 'length') {
    throw new NousTruncatedError(request.model, request.max_tokens, usage);
  }

  const refusal = typeof choice.message?.refusal === 'string' ? choice.message.refusal : '';
  if (finish_reason === 'content_filter' || refusal.trim() !== '') {
    throw new NousRefusalError(
      request.model,
      finish_reason === 'content_filter' ? 'finish_reason="content_filter"' : 'message.refusal',
      usage,
      refusal === '' ? undefined : refusal,
    );
  }

  return {
    text: typeof choice.message?.content === 'string' ? choice.message.content : '',
    usage,
    model: resolveMeteredModel(parsed.model, request.model),
    finish_reason,
    ttfb_ms,
  };
}
