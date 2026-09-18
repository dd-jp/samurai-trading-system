import { LlmMalformedResponseError } from './errors.js';
import type { LlmClient, LlmRequest, LlmResponse } from './types.js';

type QueuedResult = { kind: 'text'; rawText: string } | { kind: 'error'; error: Error };

export class MockLlmClient implements LlmClient {
  private readonly queue: QueuedResult[] = [];

  readonly requests: Array<LlmRequest<unknown>> = [];

  enqueueText(rawText: string): void {
    this.queue.push({ kind: 'text', rawText });
  }

  enqueueError(error: Error): void {
    this.queue.push({ kind: 'error', error });
  }

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.requests.push(request as LlmRequest<unknown>);

    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        'MockLlmClient: no queued response for this call — call enqueueText/enqueueError first',
      );
    }
    if (next.kind === 'error') {
      throw next.error;
    }

    const parsed = request.parseResponse(next.rawText);
    if (!parsed.valid) {
      throw new LlmMalformedResponseError(parsed.reason);
    }

    return { data: parsed.data, raw_text: next.rawText, latency_ms: 0 };
  }
}
