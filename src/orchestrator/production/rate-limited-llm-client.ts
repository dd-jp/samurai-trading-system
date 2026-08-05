/**
 * The production call site `RateLimiter` never had (#388).
 *
 * `RateLimiter` (debate-engine/rate-limiter.ts) was implemented, tested and
 * exported, and constructed nowhere outside its own test — the seventh
 * instance of this repo's dominant defect class in two days. The throttle the
 * system actually ran on was `maxConcurrentInstruments: 1`, an incidental
 * property of a concurrency default rather than of the component built to
 * provide it, and one config change away from vanishing.
 *
 * This decorator is the metering half of the fix: every LLM call a debate
 * makes goes through `complete` here, so `recordCall` cannot be forgotten at a
 * call site the way it was forgotten at the composition root. The admission
 * half (`reserve`, once per debate) is in `debate-adapter.ts`.
 *
 * ## It does not wait, and that is the decision
 *
 * `RateLimiter` has no blocking API at all: `reserve` returns
 * `{granted}`/`{granted: false, reason}` synchronously and `recordCall` is a
 * counter increment. Nothing here adds a wait on top, deliberately —
 *
 * - a limiter that parks a call behind a 60s tick is its own failure mode
 *   (#388 says so in as many words): the tick loop is a `setTimeout` chain, so
 *   a parked debate stretches the whole cadence rather than shedding load; and
 * - a wait is precisely what creates a ZOMBIE against #347/#373's cancellation
 *   contract. A call parked in a limiter while the debate's latency budget
 *   fires would wake up after `enforceLatencyBudget` has already returned its
 *   fallback, issue a request nobody reads, and bill for it — the exact leak
 *   #347 closed at the transport.
 *
 * So the posture is FAIL-FAST, not wait: the budget is checked once, up front,
 * before a debate starts (see `buildDebateStep`), and a debate that is admitted
 * runs to completion without ever being parked mid-flight.
 *
 * ## What it does owe the cancellation contract
 *
 * With no wait of its own, the only zombie this layer can create is issuing —
 * and billing — a call for a debate that has ALREADY been cancelled. The round
 * orchestrator stops issuing calls on abort, but a persona call in the middle
 * of the `bull -> bear -> mediator` sequence can find the signal aborted
 * between being constructed and being sent. Checking here is a cheap, exact
 * backstop: an aborted request is refused before it reaches the transport and
 * WITHOUT spending budget, because a call that never went out consumed no
 * provider quota.
 */
import {
  type AssetClass,
  LlmCancelledError,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type RateLimiter,
} from '../../debate-engine/index.js';

export class RateLimitedLlmClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly rateLimiter: RateLimiter,
    /**
     * Fixed at construction rather than read per call: `LlmRequest` carries no
     * instrument, and one of these is built per debate (`buildDebatePersonas`
     * is already per-debate state), so the class is known exactly where the
     * decorator is created and guessing it here would be the invention.
     */
    private readonly assetClass: AssetClass,
  ) {}

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    if (request.signal?.aborted === true) {
      throw new LlmCancelledError(
        `LLM call not issued: the debate was already cancelled (${describeAbort(request.signal)})`,
        request.signal.reason,
      );
    }

    // BEFORE the call, not after. The provider counts a request the moment it
    // arrives, so a local counter that credits only successful calls drifts
    // downward under exactly the conditions — timeouts, 429s, 5xx — that make
    // the budget matter. Over-counting a failed call is the safe direction.
    this.rateLimiter.recordCall(this.assetClass);

    return this.inner.complete(request);
  }
}

/** The abort reason as text, so the refusal says WHY rather than "aborted". */
function describeAbort(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason.message;
  return reason === undefined ? 'no reason given' : String(reason);
}
