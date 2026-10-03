import type { AnthropicUsage, LlmInFlightRefusalReason } from '../../llm/index.js';

export type LlmTimeoutSource = 'deadline' | 'status';

export class LlmTimeoutError extends Error {
  readonly source: LlmTimeoutSource;

  constructor(message: string, source: LlmTimeoutSource = 'deadline') {
    super(message);
    this.name = 'LlmTimeoutError';
    this.source = source;
  }
}

export class LlmRateLimitError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'LlmRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class LlmMalformedResponseError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`malformed LLM response: ${reason}`);
    this.name = 'LlmMalformedResponseError';
    this.reason = reason;
  }
}

export class LlmAdmissionRefusedError extends Error {
  readonly reason: LlmInFlightRefusalReason;
  readonly queue_depth: number;
  readonly in_flight: number;
  readonly budget_ms: number;
  readonly waited_ms: number;

  constructor(refusal: {
    message: string;
    reason: LlmInFlightRefusalReason;
    queue_depth: number;
    in_flight: number;
    budget_ms: number;
    waited_ms: number;
  }) {
    super(refusal.message);
    this.name = 'LlmAdmissionRefusedError';
    this.reason = refusal.reason;
    this.queue_depth = refusal.queue_depth;
    this.in_flight = refusal.in_flight;
    this.budget_ms = refusal.budget_ms;
    this.waited_ms = refusal.waited_ms;
  }
}

export interface BilledUsage {
  readonly usage: AnthropicUsage;
  readonly model?: string | undefined;
}

export class LlmProviderError extends Error {
  readonly usage: AnthropicUsage | undefined;
  readonly model: string | undefined;

  constructor(message: string, billed?: BilledUsage) {
    super(message);
    this.name = 'LlmProviderError';
    this.usage = billed?.usage;
    this.model = billed?.model;
  }
}

export class LlmCancelledError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LlmCancelledError';
  }
}

export class LlmRefusalError extends Error {
  readonly signal: string;
  readonly usage: { input_tokens: number; output_tokens: number } | undefined;

  constructor(
    message: string,
    signal: string,
    usage?: { input_tokens: number; output_tokens: number },
  ) {
    super(message);
    this.name = 'LlmRefusalError';
    this.signal = signal;
    this.usage = usage;
  }
}

export class LlmTruncatedError extends Error {
  readonly model: string;
  readonly max_tokens: number;
  readonly usage: { input_tokens: number; output_tokens: number } | undefined;

  constructor(
    message: string,
    model: string,
    max_tokens: number,
    usage?: { input_tokens: number; output_tokens: number },
  ) {
    super(message);
    this.name = 'LlmTruncatedError';
    this.model = model;
    this.max_tokens = max_tokens;
    this.usage = usage;
  }
}
