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
import { rateFor } from './pricing.js';

/** Wider than the callers' own timeouts — a backstop that reaps a dangling socket after an outer race has settled, not a race partner. */
export const DEFAULT_NOUS_TIMEOUT_MS = 60_000;

/** Caps how much of a response body is ever baked into an error message (goes straight to logs). */
const MAX_ERROR_BODY_CHARS = 500;

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
  usage: { input_tokens: number; output_tokens: number };
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

/**
 * Typed failure for this client's network boundary.
 *
 * Carries `.status` because that is the field
 * `AnthropicLlmClient.classifyProviderError` duck-types into the typed LLM
 * error hierarchy — 429 becomes `LlmRateLimitError`, 408/504 become
 * `LlmTimeoutError`, both of which retry. Dropping the status would turn every
 * rate limit into an unretried hard failure.
 */
export class NousApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'NousApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * The response ran out of `max_tokens` before the model finished
 * (`finish_reason === 'length'`).
 *
 * Deliberately carries NO `.status`, so `classifyProviderError` lands it on
 * `LlmProviderError`, which `isRetryable` (anthropic-client.ts) rejects. That
 * is the whole reason this class exists.
 *
 * A truncated completion arrives as partial — often empty — text. Without this
 * it would reach `parseResponse`, fail, become `LlmMalformedResponseError`,
 * and be RETRIED, which re-bills a deterministic failure at the same
 * `max_tokens` that just failed. The repo has already paid for this lesson
 * once: `.github/workflows/ai-review.yml` records kimi-k3 spending its entire
 * budget on hidden chain-of-thought and returning `finish_reason=length` with
 * zero content, every time.
 *
 * The tokens it burned are NOT metered — every throw at this wire boundary
 * skips `AnthropicLlmClient.recordSpend`, which runs only on a returned
 * response. `usage` is carried on the error so the cost is at least visible in
 * the log rather than merely absent. Closing that gap properly means metering
 * failures too, which is a change to the spend sink's contract and its own
 * ticket; not retrying is what keeps the unmetered amount bounded to one call.
 */
export class NousTruncatedError extends Error {
  readonly model: string;
  readonly max_tokens: number;
  /** Tokens the provider billed for this truncated call. Unmetered — see the class doc comment. */
  readonly usage: { input_tokens: number; output_tokens: number };

  constructor(
    model: string,
    max_tokens: number,
    usage: { input_tokens: number; output_tokens: number },
  ) {
    const output_tokens = usage.output_tokens;
    super(
      `Nous response truncated: ${model} hit finish_reason="length" after ${output_tokens} ` +
        `output tokens against max_tokens=${max_tokens}. Not retried — a retry at the same ` +
        'budget fails identically and bills again. Raise max_tokens or choose a model that ' +
        'does not spend the budget on hidden reasoning tokens.',
    );
    this.name = 'NousTruncatedError';
    this.model = model;
    this.max_tokens = max_tokens;
    this.usage = usage;
  }
}

interface NousChoice {
  message?: { content?: unknown };
  finish_reason?: unknown;
}

interface NousResponseBody {
  choices?: NousChoice[];
  model?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

function truncateForError(text: string): string {
  return text.length > MAX_ERROR_BODY_CHARS
    ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated, ${text.length} chars total)`
    : text;
}

/** Best-effort extraction of an OpenAI-style `{ error: { type, message } }` envelope. */
function describeErrorBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const detail = (body as { error?: { type?: unknown; message?: unknown } }).error;
  if (typeof detail !== 'object' || detail === null) return undefined;
  const type = typeof detail.type === 'string' ? detail.type : 'error';
  const message = typeof detail.message === 'string' ? detail.message : undefined;
  return message === undefined ? undefined : `${type}: ${message}`;
}

async function buildApiError(response: Response): Promise<NousApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const detail = describeErrorBody(body) ?? response.statusText;
  return new NousApiError(response.status, `Nous API error: ${response.status} ${detail}`, body);
}

function toTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Which model id the spend meter should price against.
 *
 * The meter prefers the model the provider says actually ran over the one that
 * was asked for, because a server-side reroute bills what ran. Through a proxy
 * that reasoning still holds, but the echoed string is no longer guaranteed to
 * be a Nous id — an upstream vendor's own id (`claude-haiku-4-5-20251001`) can
 * come back instead, and either it prices at nothing or, worse, at some other
 * table entry's rate.
 *
 * Both outcomes are wrong in the same direction as the cap: unpriced rows
 * contribute ZERO to `spend-cap.ts`'s sum, so an unrecognised echo silently
 * lifts the $50/14d ceiling. So the echo is honoured only when this table can
 * price it; otherwise the requested id — which `nousCredentials` has already
 * proved is priceable — is what gets metered.
 */
function resolveMeteredModel(echoed: unknown, requested: string): string {
  return typeof echoed === 'string' && rateFor(echoed) !== null ? echoed : requested;
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

  // #1010: this reads exactly two fields off the OpenAI-shaped `usage`
  // object and drops everything else — including any cache-related fields a
  // provider or proxy might return (e.g. an OpenAI-style
  // `prompt_tokens_details.cached_tokens`, or an Anthropic-style
  // `cache_read_input_tokens` passed through verbatim). `NousChatResult.usage`
  // above has no slot for them either. So even in a world where caching WAS
  // requested and honoured upstream, this function would still report zero
  // cache tokens to `AnthropicLlmClient.recordSpend` -> `spend-sink.ts` ->
  // `llm_spend`, which is a structurally separate cause of the all-zero
  // `cache_creation_input_tokens`/`cache_read_input_tokens` columns #1010
  // measured, from "nothing ever asks for caching" (anthropic-client.ts's
  // `renderMessageContent`, which #1010 also found does not clear the
  // model's minimum). `nous-chat.test.ts`'s "cache accounting" block
  // characterizes this drop so it can't silently persist unnoticed if the
  // token-size gate above is ever cleared by a future model change.
  const usage = {
    input_tokens: toTokenCount(parsed.usage?.prompt_tokens),
    output_tokens: toTokenCount(parsed.usage?.completion_tokens),
  };
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
