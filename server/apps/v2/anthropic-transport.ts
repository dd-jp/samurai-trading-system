import type { AnthropicMessageRequest } from '../../pipeline/debate-engine/index.js';
import {
  asRecord,
  HttpMessagesTransport,
  type HttpTransportOptions,
  numberOr,
  type WireCodec,
  type WireReply,
} from './llm-transport.js';
import { ANTHROPIC_API_VERSION, ANTHROPIC_MESSAGES_URL } from './models.js';

function finishOf(stopReason: unknown): WireReply['finish'] {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => asRecord(block))
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
}

const ANTHROPIC_CODEC: WireCodec = {
  url: ANTHROPIC_MESSAGES_URL,
  headers: (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_API_VERSION }),
  body: (request: AnthropicMessageRequest) => ({
    model: request.model,
    max_tokens: request.max_tokens,
    messages: request.messages,
  }),
  decode: (json) => {
    const body = asRecord(json);
    const usage = asRecord(body.usage);
    return {
      text: textOf(body.content),
      usage: {
        input_tokens: numberOr(usage.input_tokens, 0),
        output_tokens: numberOr(usage.output_tokens, 0),
        cache_creation_input_tokens: numberOr(usage.cache_creation_input_tokens, 0),
        cache_read_input_tokens: numberOr(usage.cache_read_input_tokens, 0),
      },
      finish: finishOf(body.stop_reason),
      upstreamModel: typeof body.model === 'string' ? body.model : undefined,
    };
  },
};

export class AnthropicHttpTransport extends HttpMessagesTransport {
  constructor(options: HttpTransportOptions) {
    super(options, ANTHROPIC_CODEC);
  }
}
