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
 * own 112,000 ms budget never binding. So a caller that could not both wait
 * AND make its call inside its own remaining budget is refused up front,
 * cheaply and legibly (`llm_gate_refused`, `FailureCause` `gate_refused`),
 * rather than admitted into a call it cannot finish. Two refusal reasons,
 * because they answer different questions:
 *
 *  - `admission` — refused on arrival, because the queue in front of it plus
 *    its own expected call already outran its budget. No slot was consumed.
 *  - `queue_deadline` — admitted to the queue on an estimate that proved
 *    optimistic, and the room its own call needs ran out while it was still
 *    waiting. The estimate is a model; this is the backstop for when the
 *    model is wrong.
 *
 * ## The predicate, and why it includes the call itself
 *
 * `estimatedWaitMs + expectedCallMs >= budgetMs`, and symmetrically the queue
 * timer fires at `budgetMs - expectedCallMs` rather than at `budgetMs`. A
 * check on the wait ALONE (what round 1 of #1080's review found here) admits a
 * caller that the estimator itself predicts will finish past its deadline: at
 * cap 1 with a 27,000 ms budget it would admit a caller estimating a 23,200 ms
 * wait, which then burns a full billed call and is recorded as a provider
 * `timeout` — the exact signature the gate exists to remove. The grant path
 * carries no second check by design: the timer above guarantees that any
 * waiter still queued when its room runs out is dropped, so a granted waiter
 * always has at least one expected call's worth of budget left.
 *
 * The estimate is deliberately crude — total expected work ahead, divided by
 * `maxInFlight` — and deliberately conservative-high: it assumes every
 * in-flight call has only just started. An over-estimate refuses a call that
 * might have squeaked through; an under-estimate admits one that will burn a
 * full deadline and produce nothing. #1080's measurement is that the second
 * mistake is the expensive one, which is also why the durations are per
 * CALLER (`LlmInFlightRequest.expectedCallMs`) rather than one constant: an X
 * retrieval call holds the permit for up to 60 s, and a debate call queued
 * behind one must not estimate its wait as though a 13 s debate call were
 * ahead of it.
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
   * The gate spends it against an ESTIMATE of the call (see
   * `expectedCallMs`), not a guarantee: it refuses a caller whose wait plus
   * expected call would not fit, and drops a queued caller once too little of
   * the budget is left for the call itself. It does NOT shorten the network
   * timeout of a call it admits — the wire timeout still bounds the call, so
   * a call that runs far past its estimate can still overrun this budget.
   *
   * Omitted means "wait as long as it takes", which is right for a caller with
   * no clock of its own and wrong for every caller inside a latency budget.
   */
  budgetMs?: number | undefined;
  /**
   * How long THIS caller's own call is expected to take once it is dispatched.
   * Defaults to the gate's `expectedCallMs`, which is calibrated on debate
   * calls; a caller in a different weight class (X retrieval, measured at
   * 5–26 s against a debate call's ~13 s) must say so, or every caller queued
   * behind it under-estimates its wait.
   */
  expectedCallMs?: number | undefined;
  /** The caller's existing cancellation. An abort while queued drops the waiter; the slot it never held is not released. */
  signal?: AbortSignal | undefined;
  /** For the log line only — `debate`, `market_intelligence_sentiment`, ... */
  llmStage?: string | undefined;
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
   * Default per-call wall time, used ONLY to estimate queue waits for the
   * admission check, and only for callers that do not declare their own
   * `LlmInFlightRequest.expectedCallMs`. See the module header for the
   * measurement.
   */
  expectedCallMs: number;
  logger?: Logger | undefined;
}

interface Waiter {
  grant(): void;
  drop(): void;
  expectedCallMs: number;
}

export class NousAccountInFlightGate implements LlmInFlightGate {
  readonly #maxInFlight: number;
  readonly #expectedCallMs: number;
  readonly #logger: Logger | undefined;
  readonly #waiters: Waiter[] = [];
  /**
   * One entry per call in flight, holding what that call said it would take.
   * The array IS the in-flight count — a separate counter could disagree with
   * it, and the estimate below reads both.
   */
  readonly #inFlightCallMs: number[] = [];

  constructor(options: NousAccountInFlightGateOptions) {
    if (!Number.isInteger(options.maxInFlight) || options.maxInFlight < 1) {
      throw new Error(
        `NousAccountInFlightGate: maxInFlight must be a positive integer, got ${options.maxInFlight}`,
      );
    }
    // Zero or negative would make every estimate 0 and silently disable
    // admission control, leaving only the `queue_deadline` backstop — the
    // mechanism-that-does-nothing shape this file exists to avoid.
    if (!Number.isFinite(options.expectedCallMs) || options.expectedCallMs <= 0) {
      throw new Error(
        `NousAccountInFlightGate: expectedCallMs must be a positive number of milliseconds, got ${options.expectedCallMs}`,
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

    const callMs = request.expectedCallMs ?? this.#expectedCallMs;

    if (this.#inFlightCallMs.length < this.#maxInFlight) {
      return Promise.resolve(this.#take(callMs));
    }

    const queueDepth = this.#waiters.length;
    const estimatedWaitMs = this.#estimateWaitMs();
    const budgetMs = request.budgetMs;
    if (budgetMs !== undefined && estimatedWaitMs + callMs >= budgetMs) {
      this.#logRefusal({
        request,
        reason: 'admission',
        queueDepth,
        budgetMs,
        waitedMs: 0,
        estimatedWaitMs,
      });
      return Promise.reject(
        new LlmInFlightRefusedError({
          reason: 'admission',
          queue_depth: queueDepth,
          in_flight: this.#inFlightCallMs.length,
          budget_ms: budgetMs,
          waited_ms: 0,
          message:
            `LLM gate refused admission: ${queueDepth} call(s) queued behind ` +
            `${this.#inFlightCallMs.length} in flight would hold this call ~${estimatedWaitMs}ms, ` +
            `leaving less than the ~${callMs}ms it needs inside its ${budgetMs}ms budget`,
        }),
      );
    }

    return this.#enqueue(request, queueDepth, budgetMs, callMs);
  }

  #enqueue(
    request: LlmInFlightRequest,
    queueDepth: number,
    budgetMs: number | undefined,
    callMs: number,
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
        expectedCallMs: callMs,
        grant: () => {
          detach();
          const waitMs = Date.now() - enqueuedAt;
          // Resolved BEFORE the log line: the slot is already counted in
          // flight, so a logger that throws between the two would leave the
          // permit held by nobody and this promise never settled.
          resolve(this.#take(callMs));
          this.#logger?.log({
            trace_id: 'llm',
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
              in_flight: this.#inFlightCallMs.length,
              max_in_flight: this.#maxInFlight,
              llm_stage: request.llmStage,
              budget_ms: budgetMs,
            },
          });
        },
        drop: () => {
          const waitedMs = Date.now() - enqueuedAt;
          detach();
          this.#logRefusal({
            request,
            reason: 'queue_deadline',
            queueDepth,
            budgetMs: budgetMs ?? 0,
            waitedMs,
          });
          reject(
            new LlmInFlightRefusedError({
              reason: 'queue_deadline',
              queue_depth: queueDepth,
              in_flight: this.#inFlightCallMs.length,
              budget_ms: budgetMs ?? 0,
              waited_ms: waitedMs,
              message:
                `LLM gate refused a queued call: after ${waitedMs}ms of waiting, its ${budgetMs}ms ` +
                `budget no longer had room for the ~${callMs}ms call itself`,
            }),
          );
        },
      };

      this.#waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (budgetMs !== undefined) {
        // The last moment a grant would still be useful, NOT the budget itself:
        // a waiter granted with less than its own call left would dispatch a
        // call that is already over deadline.
        timer = setTimeout(() => waiter.drop(), Math.max(0, budgetMs - callMs));
      }
    });
  }

  /**
   * Total expected work ahead of a new arrival — every in-flight call assumed
   * to have only just started — served `maxInFlight` at a time. See the module
   * header for why the conservative direction is the right one.
   */
  #estimateWaitMs(): number {
    const ahead = [
      ...this.#inFlightCallMs,
      ...this.#waiters.map((waiter) => waiter.expectedCallMs),
    ];
    const total = ahead.reduce((sum, callMs) => sum + callMs, 0);
    return Math.floor(total / this.#maxInFlight);
  }

  #take(callMs: number): LlmInFlightSlot {
    this.#inFlightCallMs.push(callMs);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const index = this.#inFlightCallMs.indexOf(callMs);
        if (index >= 0) this.#inFlightCallMs.splice(index, 1);
        this.#waiters.shift()?.grant();
      },
    };
  }

  #logRefusal(fields: {
    request: LlmInFlightRequest;
    reason: LlmInFlightRefusalReason;
    queueDepth: number;
    budgetMs: number;
    waitedMs: number;
    estimatedWaitMs?: number;
  }): void {
    const llmStage = fields.request.llmStage;
    this.#logger?.log({
      trace_id: 'llm',
      stage: llmStage ?? 'orchestrator',
      event: 'llm_gate_refused',
      level: 'warn',
      message:
        `llm gate: refused a ${llmStage ?? 'nous'} call (${fields.reason}) — ${fields.queueDepth} ` +
        `queued behind ${this.#inFlightCallMs.length} in flight against a ${fields.budgetMs}ms ` +
        'budget. The call was NOT sent, so it burned no deadline and no tokens; it is counted as ' +
        '`gate_refused`, not as a provider timeout (#1080)',
      payload: {
        reason: fields.reason,
        queue_depth: fields.queueDepth,
        in_flight: this.#inFlightCallMs.length,
        max_in_flight: this.#maxInFlight,
        budget_ms: fields.budgetMs,
        waited_ms: fields.waitedMs,
        llm_stage: llmStage,
        ...(fields.estimatedWaitMs === undefined
          ? {}
          : { estimated_wait_ms: fields.estimatedWaitMs }),
      },
    });
  }
}
