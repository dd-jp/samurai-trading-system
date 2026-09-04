/**
 * The one place this system speaks to an LLM provider.
 *
 * Nous fronts every vendor behind a single OpenAI-compatible
 * `POST {baseUrl}/chat/completions`, so both LLM surfaces — the debate engine
 * and the market-intelligence sentiment agent — reduce to this helper plus a
 * thin adapter each. One helper rather than two clients is the point: the
 * `finish_reason` handling below is a money bug if it is implemented once and
 * forgotten once.
 *
 * Uses `fetchWithTimeout` (issue #271) like every other real HTTP client in
 * the repo rather than hand-rolling an `AbortController`/`setTimeout` pairing,
 * and stays non-streaming — `debate-engine-spec.md`'s latency budgets (15s
 * crypto / 60s stocks) never needed streaming, and `transport-layer-spec.md`
 * records the no-SDK-dependency decision this preserves.
 *
 * ## Secret handling
 *
 * The key rides in an `Authorization` header, never in a URL, and no error
 * message here interpolates the request body — the same rule
 * `telegram-errors.ts` follows, for the same reason: these strings go straight
 * to logs, and a provider echoing the request back would put the key in them.
 */

import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import {
  buildApiError,
  DEFAULT_NOUS_TIMEOUT_MS,
  NousApiError,
  NousTruncatedError,
  type NousWireUsage,
  normaliseUsage,
  resolveMeteredModel,
  truncateForError,
} from './nous-wire.js';
import type { AnthropicUsage } from './pricing.js';

// Re-exported, not redefined: `nous-wire.ts` owns these now so
// `nous-responses.ts` cannot fork them (see that module's header). Existing
// importers — `shared/llm/index.ts`, `nous-messages-client.ts`,
// `nous-sentiment-client.ts`, `nous-chat.test.ts` — are unaffected.
export {
  DEFAULT_NOUS_TIMEOUT_MS,
  NousApiError,
  NousTruncatedError,
} from './nous-wire.js';

export interface NousChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface NousChatRequest {
  model: string;
  messages: readonly NousChatMessage[];
  max_tokens: number;
}

export interface NousChatResult {
  /** The assistant's text. Never `undefined` — an absent content field reads as the empty string. */
  text: string;
  /**
   * Normalised by `normaliseUsage`, so `input_tokens` EXCLUDES cached tokens
   * and `cache_read_input_tokens` carries them separately — the Anthropic
   * convention `priceUsage` bills against, not the OpenAI-inclusive one Nous
   * reports on the wire.
   */
  usage: AnthropicUsage;
  /**
   * Server-side tool invocations this call billed for, when the endpoint
   * reports any. Always absent here: `chat/completions` takes FUNCTION tools,
   * which run on the caller's side and bill no invocation fee. The field is on
   * the shared result shape so `spend-sink.ts` has one path to read, and
   * `nous-responses.ts` is what populates it.
   */
  server_tool_calls?: number;
  /**
   * The model id to METER against — see `resolveMeteredModel`. Not necessarily
   * the string the provider echoed.
   */
  model: string;
  /** As reported by the provider, for callers that want to log it. `'length'` never reaches a caller — it throws. */
  finish_reason: string | null;
  /**
   * Time-to-first-byte (#1012): milliseconds from dispatching the POST to
   * `fetchWithTimeout`'s promise settling — i.e. HTTP response headers
   * received — measured BEFORE `response.json()` reads the body. Distinct
   * from the caller's `latency_ms` (`anthropic-client.ts`), which spans
   * headers-received AND the full body read using its own, separately
   * started span of the same `Date.now()` clock; the two will normally read
   * almost equal (a small JSON reply has a negligible body-read component)
   * but are not the same measurement — see `migrations/0038_llm_spend_ttfb.sql`
   * for what a meaningful gap between them would mean.
   */
  ttfb_ms: number;
}

export interface NousChatOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  /** Cancellation from the caller (the debate's latency budget). Composed with the timeout inside `fetchWithTimeout`. */
  signal?: AbortSignal | undefined;
}

interface NousChoice {
  message?: { content?: unknown };
  finish_reason?: unknown;
}

interface NousResponseBody {
  choices?: NousChoice[];
  model?: unknown;
  usage?: NousWireUsage;
}

/** POSTs one non-streaming chat completion to Nous and normalises the reply. */
export async function nousChat(
  options: NousChatOptions,
  request: NousChatRequest,
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
    options.timeoutMs ?? DEFAULT_NOUS_TIMEOUT_MS,
  );
  // Measured here, before `response.json()` below reads the body — see the
  // `ttfb_ms` doc comment on `NousChatResult`. Captured for every response
  // regardless of `ok`, but only threaded through on the success path below;
  // the error paths (`buildApiError`, the JSON-parse-failure branch) don't
  // carry a `NousChatResult` at all, matching how `usage`/`latency_ms` are
  // already dropped on every thrown error at this boundary (see
  // `NousTruncatedError`'s doc comment).
  const ttfb_ms = Date.now() - dispatchedAt;

  if (!response.ok) {
    throw await buildApiError(response);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    // A 2xx with an unparseable body (truncated stream, HTML from an
    // intermediary proxy) would otherwise escape as a raw, unclassified
    // `SyntaxError`.
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

  // #1010 characterized this site as DROPPING every cache field the provider
  // reported, which made the all-zero `cache_read_input_tokens` column a
  // property of this parser as well as of "nothing ever asks for caching".
  // The drop is now fixed: `normaliseUsage` reads
  // `prompt_tokens_details.cached_tokens` and — critically — subtracts it out
  // of `input_tokens`, because Nous reports OpenAI-inclusive usage where a
  // cached token is also a prompt token. #1010's other finding stands
  // unchanged: nothing here REQUESTS caching, and the pinned debate model's
  // requests measure under its cache minimum anyway, so this path normally
  // sees a zero and reports a real zero. It stops being zero on the retrieval
  // path (#969), where the provider caches large search prompts on its own
  // initiative — which is exactly why the drop had to go.
  const usage = normaliseUsage(parsed.usage);
  const finish_reason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;

  if (finish_reason === 'length') {
    throw new NousTruncatedError(request.model, request.max_tokens, usage);
  }

  return {
    text: typeof choice.message?.content === 'string' ? choice.message.content : '',
    usage,
    model: resolveMeteredModel(parsed.model, request.model),
    finish_reason,
    ttfb_ms,
  };
}
