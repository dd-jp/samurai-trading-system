import type { LlmInFlightGate, NousChatOptions } from '../../../shared/llm/index.js';
import {
  LlmInFlightRefusedError,
  NousRefusalError,
  NousTruncatedError,
  nousChat,
} from '../../../shared/llm/index.js';
import type {
  AnthropicMessageOptions,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicMessagesClient,
} from './anthropic-client.js';
import { LlmAdmissionRefusedError, LlmRefusalError, LlmTruncatedError } from './errors.js';

function toLlmError(error: unknown): unknown {
  if (error instanceof NousRefusalError) {
    return new LlmRefusalError(error.message, error.signal, error.usage);
  }
  if (error instanceof NousTruncatedError) {
    return new LlmTruncatedError(error.message, error.model, error.max_tokens, error.usage);
  }
  if (error instanceof LlmInFlightRefusedError) {
    return new LlmAdmissionRefusedError(error);
  }
  return error;
}

export interface NousMessagesClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  gate: LlmInFlightGate;
  gateBudgetMs?: number | undefined;
}

export class NousMessagesClient implements AnthropicMessagesClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number | undefined;
  readonly #gate: LlmInFlightGate;
  readonly #gateBudgetMs: number | undefined;

  constructor(options: NousMessagesClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl;
    this.#timeoutMs = options.timeoutMs;
    this.#gate = options.gate;
    this.#gateBudgetMs = options.gateBudgetMs;
  }

  async createMessage(
    request: AnthropicMessageRequest,
    options: AnthropicMessageOptions = {},
  ): Promise<AnthropicMessageResponse> {
    const result = await nousChat(this.#chatOptions(options), {
      model: request.model,
      messages: request.messages,
      max_tokens: request.max_tokens,
    }).catch((error: unknown) => {
      throw toLlmError(error);
    });
    return {
      content: [{ type: 'text', text: result.text }],
      usage: result.usage,
      model: result.model,
      upstream_model: result.upstream_model,
      ttfb_ms: result.ttfb_ms,
    };
  }

  #chatOptions(options: AnthropicMessageOptions): NousChatOptions {
    return {
      apiKey: this.#apiKey,
      baseUrl: this.#baseUrl,
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
      signal: options.signal,
      gate: this.#gate,
      gateBudgetMs: this.#gateBudgetMs,
      llmStage: options.stage ?? 'debate',
    };
  }
}
