/**
 * Typed error hierarchy for `LlmClient` failures (ticket #31, debate-engine-
 * spec.md "LLM Selection & Prompt Engineering" out-of-scope note — this is
 * that implementation detail). Callers (#26 personas, #32 disagreement
 * detection) branch on error *type*, not on parsing provider-specific
 * messages, and `anthropic-client.ts`'s `isRetryable` (closed over the
 * shared `src/shared/http/retry.ts` loop, #271) uses these types to decide
 * what is worth retrying.
 */

export class LlmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

export class LlmRateLimitError extends Error {
  /** Provider-supplied hint for how long to wait, if one was given. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'LlmRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The raw response didn't match what the caller's `parseResponse` expected
 * (debate-engine-spec.md story 11's semantic detection and the mediator's
 * synthesis both depend on structured output — a prose-only reply is a
 * malformed response for their purposes, not a client bug).
 */
export class LlmMalformedResponseError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`malformed LLM response: ${reason}`);
    this.name = 'LlmMalformedResponseError';
    this.reason = reason;
  }
}

/** Any other upstream failure (auth, bad request, 5xx, network) — not classified further. */
export class LlmProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

export type LlmError =
  | LlmTimeoutError
  | LlmRateLimitError
  | LlmMalformedResponseError
  | LlmProviderError;
