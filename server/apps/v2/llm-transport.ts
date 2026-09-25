import type {
  AnthropicMessageOptions,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicMessagesClient,
} from '../../pipeline/debate-engine/index.js';
import { LlmProviderError, NousMessagesClient } from '../../pipeline/debate-engine/index.js';
import type { Logger } from '../../shared/index.js';
import type { LlmInFlightGate } from '../../shared/llm/index.js';
import type { ModelPin } from './models.js';

export interface NousPinnedTransportOptions {
  readonly pin: ModelPin;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly gate: LlmInFlightGate;
  readonly logger?: Logger | undefined;
}

export class NousPinnedTransport implements AnthropicMessagesClient {
  readonly #pin: ModelPin;
  readonly #logger: Logger | undefined;
  readonly #client: AnthropicMessagesClient;

  constructor(options: NousPinnedTransportOptions) {
    this.#pin = options.pin;
    this.#logger = options.logger;
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
}
