import type {
  AnthropicMessageRequest,
  AnthropicMessagesClient,
} from '../../../pipeline/debate-engine/index.js';
import type { ModelPin } from './models.js';

export interface ScriptedCall {
  readonly model: string;
  readonly stage: string | undefined;
  readonly prompt: string;
}

export type Script = (request: AnthropicMessageRequest) => string;

export const BULLISH_SCRIPT: Script = (request) => {
  const prompt = request.messages[0]?.content ?? '';
  if (prompt.includes('Signal veto persona')) return '{"veto":false,"reason":"scripted"}';
  return prompt.includes('Mediator persona')
    ? '{"stance":"bullish","rationale":"scripted","converged":true}'
    : '{"stance":"bullish","rationale":"scripted"}';
};

export class ScriptedTransport implements AnthropicMessagesClient {
  readonly calls: ScriptedCall[] = [];

  constructor(
    private readonly pin: ModelPin,
    private readonly script: Script,
  ) {}

  createMessage(
    request: AnthropicMessageRequest,
    options: { signal?: AbortSignal | undefined; stage?: string | undefined } = {},
  ) {
    this.calls.push({
      model: request.model,
      stage: options.stage,
      prompt: request.messages[0]?.content ?? '',
    });
    return Promise.resolve({
      content: [{ type: 'text', text: this.script(request) }],
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
      model: this.pin.priced,
      ttfb_ms: 0,
    });
  }
}
