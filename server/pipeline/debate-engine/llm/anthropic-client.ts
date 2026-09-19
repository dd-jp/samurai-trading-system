import { type RetryAttemptReport, withRetry } from '../../../shared/index.js';
import type { AnthropicUsage } from '../../../shared/llm/index.js';
import { hashPromptTemplate } from '../../../shared/llm/index.js';
import {
  LlmAdmissionRefusedError,
  LlmCancelledError,
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmTimeoutError,
  LlmTruncatedError,
} from './errors.js';
import { classifyFailureCause, type FailureCause } from './failure-cause.js';
import { UNTRUSTED_WRAPPER_TEMPLATE, wrapUntrusted } from './prompt-safety.js';
import { type LlmSpendSink, NULL_SPEND_SINK } from './spend-sink.js';
import {
  LLM_CONTEXT_FIELD_KIND,
  type LlmClient,
  type LlmRequest,
  type LlmRequestContext,
  type LlmResponse,
  type LlmRetryConfig,
} from './types.js';

function isRetryable(error: unknown): boolean {
  if (error instanceof LlmTimeoutError) {
    return error.source === 'status';
  }
  return error instanceof LlmRateLimitError || error instanceof LlmMalformedResponseError;
}

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user'; content: string }>;
}

export interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: AnthropicUsage;
  stop_reason?: string;
  model?: string;
  ttfb_ms?: number;
}

export interface AnthropicMessageOptions {
  signal?: AbortSignal | undefined;
  stage?: string | undefined;
}

export interface AnthropicMessagesClient {
  createMessage(
    request: AnthropicMessageRequest,
    options?: AnthropicMessageOptions,
  ): Promise<AnthropicMessageResponse>;
}

interface LlmRetryAttemptReport extends RetryAttemptReport {
  model: string;
  trace_id: string | undefined;
  stage: string | undefined;
  debate_id: string | undefined;
}

export interface LlmCallFailureReport {
  failure_cause: FailureCause;
  error: unknown;
  model: string;
  trace_id: string | undefined;
  stage: string | undefined;
  debate_id: string | undefined;
}

export interface AnthropicLlmClientConfig {
  model: string;
  max_tokens: number;
  timeoutMs: number;
  retry: LlmRetryConfig;
  onRetryAttempt?: ((report: LlmRetryAttemptReport) => void) | undefined;
  onCallFailed?: ((report: LlmCallFailureReport) => void) | undefined;
}

function promptContextOf(context: LlmRequestContext): Record<string, unknown> {
  const promptContext: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(LLM_CONTEXT_FIELD_KIND)) {
    if (kind !== 'prompt') {
      continue;
    }
    const value = context[field as keyof LlmRequestContext];
    if (value !== undefined) {
      promptContext[field] = value;
    }
  }
  return promptContext;
}

export function renderMessageContent<T>(request: LlmRequest<T>): string {
  const contextJson = JSON.stringify(promptContextOf(request.context), null, 2);
  return `${request.prompt}\n\nContext:\n${wrapUntrusted(contextJson)}`;
}

const WIRE_ENVELOPE_TEMPLATE = `\n\nContext:\n${UNTRUSTED_WRAPPER_TEMPLATE}`;
export const WIRE_ENVELOPE_TEMPLATE_HASH = hashPromptTemplate(WIRE_ENVELOPE_TEMPLATE);

function withWireEnvelope(callTemplateHash: string | undefined): string | undefined {
  return callTemplateHash === undefined
    ? undefined
    : hashPromptTemplate(`${callTemplateHash}:${WIRE_ENVELOPE_TEMPLATE_HASH}`);
}

function extractText(response: AnthropicMessageResponse): string {
  return response.content
    .filter(
      (block): block is { type: string; text: string } =>
        block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

const ALREADY_CLASSIFIED_ERROR_TYPES = [
  LlmTimeoutError,
  LlmRateLimitError,
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRefusalError,
  LlmTruncatedError,
  LlmAdmissionRefusedError,
];

function statusOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { status?: unknown }).status
    : undefined;
}

function classifyProviderError(error: unknown): Error {
  if (ALREADY_CLASSIFIED_ERROR_TYPES.some((errorType) => error instanceof errorType)) {
    return error as Error;
  }

  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);

  if (status === 429) {
    return new LlmRateLimitError(message);
  }
  if (status === 408 || status === 504) {
    return new LlmTimeoutError(message, 'status');
  }
  return new LlmProviderError(message);
}

export class AnthropicLlmClient implements LlmClient {
  constructor(
    private readonly client: AnthropicMessagesClient,
    private readonly config: AnthropicLlmClientConfig,
    private readonly spendSink: LlmSpendSink = NULL_SPEND_SINK,
  ) {}

  complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    if (request.signal?.aborted === true) {
      return Promise.reject(
        this.reportFailure(
          request,
          new LlmCancelledError(
            'LLM call cancelled before dispatch: caller signal already aborted',
          ),
        ),
      );
    }
    const onRetryAttempt = this.config.onRetryAttempt;
    return withRetry(
      () => this.attempt(request),
      this.config.retry,
      isRetryable,
      onRetryAttempt === undefined
        ? undefined
        : (report) => {
            const attribution = request.context.attribution;
            onRetryAttempt({
              ...report,
              model: this.config.model,
              trace_id: attribution?.trace_id,
              stage: attribution?.stage,
              debate_id: attribution?.debate_id,
            });
          },
    ).catch((error: unknown) => {
      throw this.reportFailure(request, error);
    });
  }

  private reportFailure<T>(request: LlmRequest<T>, error: unknown): unknown {
    const onCallFailed = this.config.onCallFailed;
    if (onCallFailed === undefined) return error;
    try {
      const attribution = request.context.attribution;
      onCallFailed({
        failure_cause: classifyFailureCause(error),
        error,
        model: this.config.model,
        trace_id: attribution?.trace_id,
        stage: attribution?.stage,
        debate_id: attribution?.debate_id,
      });
    } catch {}
    return error;
  }

  private async attempt<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    const start = Date.now();
    const content = renderMessageContent(request);
    const attribution = request.context.attribution;
    const gateStage = attribution?.gate_stage ?? attribution?.stage;
    const response = await this.callWithTimeout(content, request.signal, gateStage);
    const latency_ms = Date.now() - start;

    let rawText = '';
    try {
      rawText = extractText(response);
    } finally {
      this.recordSpend(request, response, latency_ms, content, rawText);
    }

    if (response.stop_reason === 'refusal') {
      throw new LlmRefusalError(
        `LLM refused to answer: ${this.config.model} returned stop_reason="refusal"`,
        'stop_reason="refusal"',
        response.usage,
      );
    }

    const parsed = request.parseResponse(rawText);
    if (!parsed.valid) {
      throw new LlmMalformedResponseError(parsed.reason);
    }

    return { data: parsed.data, raw_text: rawText, latency_ms };
  }

  private recordSpend<T>(
    request: LlmRequest<T>,
    response: AnthropicMessageResponse,
    latency_ms: number,
    prompt: string,
    responseText: string,
  ): void {
    if (response.usage === undefined) return;
    try {
      this.spendSink.record({
        trace_id: request.context.attribution?.trace_id ?? 'unattributed',
        stage: request.context.attribution?.stage ?? 'debate',
        debate_id: request.context.attribution?.debate_id,
        model: response.model ?? this.config.model,
        usage: response.usage,
        latency_ms,
        ttfb_ms: response.ttfb_ms,
        timestamp: new Date(),
        prompt,
        response: responseText,
        prompt_template_hash: withWireEnvelope(request.context.attribution?.prompt_template_hash),
      });
    } catch {}
  }

  private async callWithTimeout(
    content: string,
    callerSignal?: AbortSignal,
    llmStage?: string,
  ): Promise<AnthropicMessageResponse> {
    const timeoutController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const expired = new LlmTimeoutError(`LLM call exceeded ${this.config.timeoutMs}ms`);
        timeoutController.abort(expired);
        reject(expired);
      }, this.config.timeoutMs);
    });

    const signal =
      callerSignal === undefined
        ? timeoutController.signal
        : AbortSignal.any([callerSignal, timeoutController.signal]);

    const call = this.client
      .createMessage(
        {
          model: this.config.model,
          max_tokens: this.config.max_tokens,
          messages: [{ role: 'user', content }],
        },
        { signal, stage: llmStage },
      )
      .catch((error) => {
        throw classifyProviderError(error);
      });

    try {
      return await Promise.race([call, timeout]);
    } catch (error) {
      if (callerSignal?.aborted === true) {
        throw new LlmCancelledError('LLM call cancelled by caller while in flight', error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
