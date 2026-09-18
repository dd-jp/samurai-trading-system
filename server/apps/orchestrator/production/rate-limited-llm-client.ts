import {
  type AssetClass,
  LlmCancelledError,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type RateLimiter,
} from '../../../pipeline/debate-engine/index.js';

export class RateLimitedLlmClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly rateLimiter: RateLimiter,
    private readonly assetClass: AssetClass,
  ) {}

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    if (request.signal?.aborted === true) {
      throw new LlmCancelledError(
        `LLM call not issued: the debate was already cancelled (${describeAbort(request.signal)})`,
        request.signal.reason,
      );
    }

    this.rateLimiter.recordCall(this.assetClass);

    return this.inner.complete(request);
  }
}

function describeAbort(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason.message;
  return reason === undefined ? 'no reason given' : String(reason);
}
