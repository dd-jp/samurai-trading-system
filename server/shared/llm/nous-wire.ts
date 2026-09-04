/**
 * The parts of the Nous wire boundary that are the SAME on every endpoint.
 *
 * ## Why this module exists
 *
 * `nous-chat.ts` opens by saying that one helper rather than two clients is
 * the point, because "the `finish_reason` handling below is a money bug if it
 * is implemented once and forgotten once". Adding a second endpoint
 * (`nous-responses.ts`, for server-side retrieval — #969) is exactly the
 * situation that warning describes. Copy-pasting the error envelope, the token
 * coercion, the meter's model resolution and the truncation refusal into a
 * second file would satisfy the compiler and re-open the bug.
 *
 * So the shared half moved here and BOTH transports import it. Anything in
 * this file is endpoint-agnostic by construction; anything that differs
 * between `chat/completions` and `responses` — request shape, where the text
 * lives, how citations are reported — stays in the transport that owns it.
 *
 * `nous-chat.ts` re-exports the error classes it used to define, so its
 * existing importers and `shared/llm/index.ts` are unaffected: this is a
 * move, not an API change.
 *
 * ## Secret handling
 *
 * Unchanged and load-bearing: the key rides in an `Authorization` header,
 * never a URL, and no error message here interpolates the request body. These
 * strings go straight to logs, and a provider echoing the request back would
 * put the key in them.
 */

import { type AnthropicUsage, rateFor } from './pricing.js';

/** Caps how much of a response body is ever baked into an error message (goes straight to logs). */
export const MAX_ERROR_BODY_CHARS = 500;

/** Wider than the callers' own timeouts — a backstop that reaps a dangling socket after an outer race has settled, not a race partner. */
export const DEFAULT_NOUS_TIMEOUT_MS = 60_000;

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

export function truncateForError(text: string): string {
  return text.length > MAX_ERROR_BODY_CHARS
    ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated, ${text.length} chars total)`
    : text;
}

/** Best-effort extraction of an OpenAI-style `{ error: { type, message } }` envelope. */
export function describeErrorBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const detail = (body as { error?: { type?: unknown; message?: unknown } }).error;
  if (typeof detail !== 'object' || detail === null) return undefined;
  const type = typeof detail.type === 'string' ? detail.type : 'error';
  const message = typeof detail.message === 'string' ? detail.message : undefined;
  return message === undefined ? undefined : `${type}: ${message}`;
}

export async function buildApiError(response: Response): Promise<NousApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  // TRUNCATED before interpolation, not after. `detail` is a provider-supplied
  // string of unbounded length — `error.message` from a body we do not control,
  // or `statusText` — and this message goes to the log sink and to alert
  // transports. An upstream that returns a megabyte of prose in `error.message`
  // would otherwise put a megabyte into every retry's log line. The full body
  // is still available unmodified on `.body` for anyone who needs it.
  const detail = truncateForError(describeErrorBody(body) ?? response.statusText);
  return new NousApiError(response.status, `Nous API error: ${response.status} ${detail}`, body);
}

export function toTokenCount(value: unknown): number {
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
export function resolveMeteredModel(echoed: unknown, requested: string): string {
  return typeof echoed === 'string' && rateFor(echoed) !== null ? echoed : requested;
}

/**
 * The OpenAI-shaped usage block, in the shapes Nous has been observed to
 * return it. Every field is `unknown` — this is wire data, coerced by
 * `normaliseUsage` rather than trusted.
 */
export interface NousWireUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  /** OpenAI's nesting. What Nous actually returns on `/responses`. */
  prompt_tokens_details?: { cached_tokens?: unknown } | undefined;
  /** The Responses API's own names, seen alongside the legacy pair. */
  input_tokens?: unknown;
  output_tokens?: unknown;
  input_tokens_details?: { cached_tokens?: unknown } | undefined;
}

/**
 * Normalise a Nous usage block into this repo's `AnthropicUsage`.
 *
 * ## The subtraction is the whole point
 *
 * Nous reports usage the OPENAI way: `cached_tokens` is a SUBSET of
 * `prompt_tokens`, not a sibling of it. `AnthropicUsage` means the Anthropic
 * thing, where `input_tokens` and `cache_read_input_tokens` are disjoint and
 * `priceUsage` bills both. Carrying the cached count across without
 * subtracting therefore bills the cached tokens TWICE — once at full input
 * rate inside `prompt_tokens`, once at the cache rate. On the measured
 * `x_search` probe (58,153 prompt of which 19,584 cached) that is a ~26%
 * over-count, and over-counting is the safe direction only for a ceiling, not
 * for the operator's spend figure.
 *
 * `Math.max(0, …)` guards the inverted case rather than trusting the
 * invariant: if a provider ever reports cached > prompt, the honest reading is
 * "all of it was cached", not a negative token count that would show up as a
 * NEGATIVE cost and quietly buy back headroom under ADR-0008's cap.
 *
 * Cache WRITES are not read here because no endpoint reports them — nothing in
 * this system requests caching (`pricing.ts`, #1010). The field exists on
 * `AnthropicUsage` and stays absent, which reads as a real zero.
 */
export function normaliseUsage(usage: NousWireUsage | undefined): AnthropicUsage {
  const promptTokens = toTokenCount(usage?.prompt_tokens ?? usage?.input_tokens);
  const cachedTokens = toTokenCount(
    usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens,
  );
  const cacheRead = Math.min(cachedTokens, promptTokens);

  return {
    input_tokens: Math.max(0, promptTokens - cacheRead),
    output_tokens: toTokenCount(usage?.completion_tokens ?? usage?.output_tokens),
    cache_read_input_tokens: cacheRead,
  };
}
