/**
 * The account-wide cap on outbound Nous calls in flight from this process
 * (#1080), with FIFO queueing and admission control.
 *
 * ## Why an ACCOUNT-wide cap and not a per-client one
 *
 * The 2026-09-14 probe (`/tmp` run record quoted in #1080) measured
 * `anthropic/claude-haiku-4.5` through Nous at p50 5,764 ms with one call in
 * flight and 18,912 ms / max 25,687 ms in a burst of four — the same prompt
 * and the same answer length, so the inflation is queueing, not work. The
 * follow-up split a three-call burst across three separate Nous API keys and
 * it was equal-or-worse than sending all three on one key (one call timed out
 * outright), which places the queue at the ACCOUNT, not the key. A per-client
 * limiter would therefore cap nothing: the debate's personas, the
 * disagreement pass, the risk critic, MI scoring and the Grok sentiment
 * refresh all land in the same upstream queue.
 *
 * That is why `nousChat` and `nousResponses` take a gate as a REQUIRED
 * option. They are the only two functions in this repo that build a Nous URL,
 * so a gate they cannot be called without is a cap no future caller can
 * forget — the alternative (an optional field, or a module-level singleton a
 * caller may not reach) is this repo's dominant defect class, a mechanism
 * nothing calls.
 *
 * ## Admission control, not just queueing
 *
 * A pure semaphore converts contention into waiting, and waiting inside a
 * per-call deadline is exactly the failure #1080 measured: 32 of 40 debates on
 * 2026-09-14 died on a single `LLM call exceeded 28000ms`, with the debate's
 * own 112,000 ms budget never binding. So a caller that would sit in the queue
 * past its own remaining budget is refused up front, cheaply and legibly
 * (`llm_gate_refused`, `FailureCause` `gate_refused`), rather than admitted
 * into a call it cannot finish. Two refusal reasons, because they answer
 * different questions:
 *
 *  - `admission` — refused on arrival, because the queue in front of it was
 *    already longer than its budget could absorb. No slot was ever consumed.
 *  - `queue_deadline` — admitted to the queue on an estimate that proved
 *    optimistic, and its budget expired while still waiting. The estimate is a
 *    model; this is the backstop for when the model is wrong.
 *
 * The estimate is deliberately crude — batches of `maxInFlight` completing
 * every `expectedCallMs` — and deliberately conservative-high: it assumes
 * every in-flight call has only just started. An over-estimate refuses a call
 * that might have squeaked through; an under-estimate admits one that will
 * burn a full deadline and produce nothing. #1080's measurement is that the
 * second mistake is the expensive one.
 */

import type { Logger } from '../types.js';

/** A held slot. `release()` is idempotent — a double release would corrupt the in-flight count. */
export interface LlmInFlightSlot {
  release(): void;
}

export type LlmInFlightRefusalReason = 'admission' | 'queue_deadline';

export class LlmInFlightRefusedError extends Error {
  readonly reason: LlmInFlightRefusalReason;
  readonly queue_depth: number;
  readonly in_flight: number;
  readonly budget_ms: number;
  readonly waited_ms: number;

  constructor(fields: {
    reason: LlmInFlightRefusalReason;
    queue_depth: number;
    in_flight: number;
    budget_ms: number;
    waited_ms: number;
    message: string;
  }) {
    super(fields.message);
    this.name = 'LlmInFlightRefusedError';
    this.reason = fields.reason;
    this.queue_depth = fields.queue_depth;
    this.in_flight = fields.in_flight;
    this.budget_ms = fields.budget_ms;
    this.waited_ms = fields.waited_ms;
  }
}

export interface LlmInFlightRequest {
  /**
   * The caller's remaining deadline for the WHOLE call, gate wait included.
   * Omitted means "wait as long as it takes", which is right for a caller with
   * no clock of its own and wrong for every caller inside a latency budget.
   */
  budgetMs?: number | undefined;
  /** The caller's existing cancellation. An abort while queued drops the waiter; the slot it never held is not released. */
  signal?: AbortSignal | undefined;
  /** For the log line only — `debate`, `market_intelligence`, ... */
  llmStage?: string | undefined;
  trace_id?: string | undefined;
}

export interface LlmInFlightGate {
  acquire(request?: LlmInFlightRequest): Promise<LlmInFlightSlot>;
}

const NO_OP_SLOT: LlmInFlightSlot = { release: () => undefined };

/**
 * The pass-through. What every unit test and every programmatic caller with
 * no account contention to manage passes; production wires a real gate at the
 * composition root.
 */
export const UNGATED_LLM_IN_FLIGHT: LlmInFlightGate = {
  acquire: () => Promise.resolve(NO_OP_SLOT),
};

export interface NousAccountInFlightGateOptions {
  maxInFlight: number;
  /**
   * Uncontended per-call wall time, used ONLY to estimate a queue wait for the
   * admission check. See the module header for the measurement.
   */
  expectedCallMs: number;
  logger?: Logger | undefined;
}

interface Waiter {
  grant(): void;
  drop(): void;
  enqueuedAt: number;
}

export class NousAccountInFlightGate implements LlmInFlightGate {
  readonly #maxInFlight: number;
  readonly #expectedCallMs: number;
  readonly #logger: Logger | undefined;
  readonly #waiters: Waiter[] = [];
  #inFlight = 0;

  constructor(options: NousAccountInFlightGateOptions) {
    if (!Number.isInteger(options.maxInFlight) || options.maxInFlight < 1) {
      throw new Error(
        `NousAccountInFlightGate: maxInFlight must be a positive integer, got ${options.maxInFlight}`,
      );
    }
    this.#maxInFlight = options.maxInFlight;
    this.#expectedCallMs = options.expectedCallMs;
    this.#logger = options.logger;
  }

  acquire(request: LlmInFlightRequest = {}): Promise<LlmInFlightSlot> {
    const signal = request.signal;
    if (signal?.aborted === true) {
      // Rejected with the caller's own reason, not a gate error: this call was
      // cancelled, and relabelling it `gate_refused` would put a deliberate
      // teardown in the bucket #1080 measures contention with.
      return Promise.reject(signal.reason);
    }

    if (this.#inFlight < this.#maxInFlight) {
      this.#inFlight += 1;
      return Promise.resolve(this.#slot());
    }

    const queueDepth = this.#waiters.length;
    const estimatedWaitMs = this.#estimateWaitMs(queueDepth);
    const budgetMs = request.budgetMs;
    if (budgetMs !== undefined && estimatedWaitMs >= budgetMs) {
      this.#logRefusal(request, 'admission', queueDepth, budgetMs, 0, estimatedWaitMs);
      return Promise.reject(
        new LlmInFlightRefusedError({
          reason: 'admission',
          queue_depth: queueDepth,
          in_flight: this.#inFlight,
          budget_ms: budgetMs,
          waited_ms: 0,
          message:
            `LLM gate refused admission: ${queueDepth} call(s) queued behind ${this.#inFlight} ` +
            `in flight would hold this call ~${estimatedWaitMs}ms, past its ${budgetMs}ms budget`,
        }),
      );
    }

    return this.#enqueue(request, queueDepth, budgetMs);
  }

  #enqueue(
    request: LlmInFlightRequest,
    queueDepth: number,
    budgetMs: number | undefined,
  ): Promise<LlmInFlightSlot> {
    return new Promise<LlmInFlightSlot>((resolve, reject) => {
      const enqueuedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = request.signal;

      const detach = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
      };

      function onAbort(): void {
        detach();
        reject(signal?.reason);
      }

      const waiter: Waiter = {
        enqueuedAt,
        grant: () => {
          detach();
          this.#inFlight += 1;
          const waitMs = Date.now() - enqueuedAt;
          this.#logger?.log({
            trace_id: request.trace_id ?? 'llm',
            stage: request.llmStage ?? 'orchestrator',
            event: 'llm_gate_wait',
            level: 'info',
            message:
              `llm gate: held a ${request.llmStage ?? 'nous'} call for ${waitMs}ms behind ` +
              `${queueDepth} queued call(s) at a cap of ${this.#maxInFlight} in flight (#1080). ` +
              "This wait is inside the caller's own budget and is counted in its `latency_ms`, " +
              'but NOT in `ttfb_ms` — the difference between those two is this number',
            payload: {
              wait_ms: waitMs,
              /** What was ALREADY queued when this call arrived — 0 for the first waiter. */
              queue_depth: queueDepth,
              in_flight: this.#inFlight,
              max_in_flight: this.#maxInFlight,
              llm_stage: request.llmStage,
              budget_ms: budgetMs,
            },
          });
          resolve(this.#slot());
        },
        drop: () => {
          const waitedMs = Date.now() - enqueuedAt;
          detach();
          this.#logRefusal(
            request,
            'queue_deadline',
            queueDepth,
            budgetMs ?? 0,
            waitedMs,
            undefined,
          );
          reject(
            new LlmInFlightRefusedError({
              reason: 'queue_deadline',
              queue_depth: queueDepth,
              in_flight: this.#inFlight,
              budget_ms: budgetMs ?? 0,
              waited_ms: waitedMs,
              message:
                `LLM gate refused a queued call: its ${budgetMs}ms budget expired after ` +
                `${waitedMs}ms of waiting, before a slot freed`,
            }),
          );
        },
      };

      this.#waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (budgetMs !== undefined) {
        timer = setTimeout(() => waiter.drop(), budgetMs);
      }
    });
  }

  /**
   * Batches of `maxInFlight` completing every `expectedCallMs`, with every
   * in-flight call assumed to have only just started — see the module header
   * for why the conservative direction is the right one.
   */
  #estimateWaitMs(queueDepth: number): number {
    return Math.floor((this.#inFlight + queueDepth) / this.#maxInFlight) * this.#expectedCallMs;
  }

  #slot(): LlmInFlightSlot {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#inFlight -= 1;
        this.#waiters.shift()?.grant();
      },
    };
  }

  #logRefusal(
    request: LlmInFlightRequest,
    reason: LlmInFlightRefusalReason,
    queueDepth: number,
    budgetMs: number,
    waitedMs: number,
    estimatedWaitMs: number | undefined,
  ): void {
    this.#logger?.log({
      trace_id: request.trace_id ?? 'llm',
      stage: request.llmStage ?? 'orchestrator',
      event: 'llm_gate_refused',
      level: 'warn',
      message:
        `llm gate: refused a ${request.llmStage ?? 'nous'} call (${reason}) — ${queueDepth} ` +
        `queued behind ${this.#inFlight} in flight against a ${budgetMs}ms budget. The call was ` +
        'NOT sent, so it burned no deadline and no tokens; it is counted as `gate_refused`, not ' +
        'as a provider timeout (#1080)',
      payload: {
        reason,
        queue_depth: queueDepth,
        in_flight: this.#inFlight,
        max_in_flight: this.#maxInFlight,
        budget_ms: budgetMs,
        waited_ms: waitedMs,
        llm_stage: request.llmStage,
        ...(estimatedWaitMs === undefined ? {} : { estimated_wait_ms: estimatedWaitMs }),
      },
    });
  }
}
