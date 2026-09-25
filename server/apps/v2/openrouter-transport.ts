import type { AnthropicMessageRequest } from '../../pipeline/debate-engine/index.js';
import {
  asRecord,
  HttpMessagesTransport,
  type HttpTransportOptions,
  numberOr,
  type WireCodec,
  type WireReply,
} from './llm-transport.js';
import { OPENROUTER_CHAT_URL, OPENROUTER_PROVIDER_ROUTING } from './models.js';

function finishOf(finishReason: unknown, refusal: unknown): WireReply['finish'] {
  if (typeof refusal === 'string' && refusal.length > 0) return 'refusal';
  switch (finishReason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

const OPENROUTER_CODEC: WireCodec = {
  url: OPENROUTER_CHAT_URL,
  headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  body: (request: AnthropicMessageRequest) => ({
    model: request.model,
    max_tokens: request.max_tokens,
    messages: request.messages,
    provider: OPENROUTER_PROVIDER_ROUTING,
  }),
  decode: (json) => {
    const body = asRecord(json);
    const choice = asRecord(Array.isArray(body.choices) ? body.choices[0] : undefined);
    const message = asRecord(choice.message);
    const usage = asRecord(body.usage);
    return {
      text: typeof message.content === 'string' ? message.content : '',
      usage: {
        input_tokens: numberOr(usage.prompt_tokens, 0),
        output_tokens: numberOr(usage.completion_tokens, 0),
      },
      finish: finishOf(choice.finish_reason, message.refusal),
      upstreamModel: typeof body.model === 'string' ? body.model : undefined,
    };
  },
};

export class OpenRouterHttpTransport extends HttpMessagesTransport {
  constructor(options: HttpTransportOptions) {
    super(options, OPENROUTER_CODEC);
  }
}
