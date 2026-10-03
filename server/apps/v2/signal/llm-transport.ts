import type {
  AnthropicMessageOptions,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicMessagesClient,
} from '../../../shared/debate/index.js';
import { LlmProviderError, NousMessagesClient } from '../../../shared/debate/index.js';
import type { Logger } from '../../../shared/index.js';
import type { LlmInFlightGate } from '../../../shared/llm/index.js';
import type { ModelPin } from './models.js';
import { leakedSecret, type SecretSource } from './secret-guard.js';

export interface NousPinnedTransportOptions {
  readonly pin: ModelPin;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly gate: LlmInFlightGate;
  readonly secrets: SecretSource;
  readonly logger?: Logger | undefined;
}

export class NousPinnedTransport implements AnthropicMessagesClient {
  readonly #pin: ModelPin;
  readonly #logger: Logger | undefined;
  readonly #client: AnthropicMessagesClient;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #secrets: SecretSource;

  constructor(options: NousPinnedTransportOptions) {
    this.#pin = options.pin;
    this.#logger = options.logger;
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl;
    this.#secrets = options.secrets;
    this.#client = new NousMessagesClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      gate: options.gate,
    });
  }

  async createMessage(
    request: AnthropicMessageRequest,
    options: AnthropicMessageOptions = {},
  ): Promise<AnthropicMessageResponse> {
    const pin = this.#pin;
    if (request.model !== pin.wire) {
      throw new LlmProviderError(
        `transport for ${pin.wire} refused a request for model ${request.model}`,
      );
    }
    const stage = options.stage ?? 'v2';
    this.#refuseSecretEgress(request, stage);
    const response = await this.#client.createMessage(request, { signal: options.signal, stage });
    this.#logger?.log({
      trace_id: 'v2-llm',
      stage,
      level: 'info',
      event: 'v2_llm_upstream_model',
      message: `${pin.wire} answered as ${response.upstream_model ?? 'unreported'}`,
      payload: { pinned: pin.wire, upstream: response.upstream_model },
    });
    if (response.upstream_model !== undefined && response.upstream_model !== pin.wire) {
      throw new LlmProviderError(
        `Nous answered for ${pin.wire} with model ${response.upstream_model}: refused, the pin is a trial`,
        response.usage === undefined ? undefined : { usage: response.usage, model: pin.priced },
      );
    }
    return { ...response, model: pin.priced };
  }

  // Mirrors the wire shape nousChat builds in server/shared/llm/nous-chat.ts; a change to its
  // URL, headers or body must be made here too or the guard checks a request never sent
  #refuseSecretEgress(request: AnthropicMessageRequest, stage: string): void {
    const leaked = leakedSecret(
      this.#secrets(),
      {
        url: `${this.#baseUrl}/chat/completions`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: request.max_tokens,
        }),
      },
      { header: 'authorization', key: this.#apiKey },
    );
    if (leaked === undefined) return;
    const message = `${this.#pin.wire} request refused before send: it carries the value of ${leaked}`;
    this.#logger?.log({
      trace_id: 'v2-llm',
      stage,
      level: 'error',
      event: 'v2_llm_secret_refused',
      message,
      payload: { pinned: this.#pin.wire, secret: leaked },
    });
    throw new LlmProviderError(message);
  }
}
