/**
 * `MockLlmClient` (ticket #31 AC: "Mock implementation for unit tests").
 * Queue-based and deterministic, matching debate-engine-spec.md's Testing
 * Decisions ("LLM mock patterns: use deterministic responses for
 * orchestration testing"). Consumers (#26 personas, #32 disagreement
 * detection) enqueue canned raw text or errors up front; each `complete`
 * call dequeues one, so a test can script an exact sequence (e.g. two
 * timeouts then a good response) without touching the network.
 */
import { LlmMalformedResponseError } from './errors.js';
import type { LlmClient, LlmRequest, LlmResponse } from './types.js';

type QueuedResult = { kind: 'text'; rawText: string } | { kind: 'error'; error: Error };

export class MockLlmClient implements LlmClient {
  private readonly queue: QueuedResult[] = [];

  /** Every request `complete` has received so far, in call order — for assertions on what was asked. */
  readonly requests: Array<LlmRequest<unknown>> = [];

  /** Queues a successful raw-text response for the next `complete` call. */
  enqueueText(rawText: string): void {
    this.queue.push({ kind: 'text', rawText });
  }

  /** Queues an error to be thrown by the next `complete` call (e.g. `LlmTimeoutError`, `LlmRateLimitError`). */
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
