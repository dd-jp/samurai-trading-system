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

  const body = await parseNousJsonBody(response);
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
  const refusal = typeof choice.message?.refusal === 'string' ? choice.message.refusal : '';

  const wireFailures: ReadonlyArray<{ test: boolean; build: () => Error }> = [
    {
      test: finish_reason === 'length',
      build: () => new NousTruncatedError(request.model, request.max_tokens, usage),
    },
    {
      test: finish_reason === 'content_filter' || refusal.trim() !== '',
      build: () =>
        new NousRefusalError(
          request.model,
          finish_reason === 'content_filter' ? 'finish_reason="content_filter"' : 'message.refusal',
          usage,
          refusal === '' ? undefined : refusal,
        ),
    },
  ];
  const wireFailure = wireFailures.find((candidate) => candidate.test);
  if (wireFailure !== undefined) throw wireFailure.build();

  return {
    text: typeof choice.message?.content === 'string' ? choice.message.content : '',
    usage,
    model: resolveMeteredModel(parsed.model, request.model),
    upstream_model: typeof parsed.model === 'string' ? parsed.model : undefined,
    finish_reason,
    ttfb_ms,
  };
}
