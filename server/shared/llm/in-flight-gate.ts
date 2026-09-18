import type { Logger } from '../types.js';

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
  budgetMs?: number | undefined;
  expectedCallMs?: number | undefined;
  signal?: AbortSignal | undefined;
  llmStage?: string | undefined;
}

export interface LlmInFlightGate {
  acquire(request?: LlmInFlightRequest): Promise<LlmInFlightSlot>;
}

const NO_OP_SLOT: LlmInFlightSlot = { release: () => undefined };

export const UNGATED_LLM_IN_FLIGHT: LlmInFlightGate = {
  acquire: () => Promise.resolve(NO_OP_SLOT),
};

export interface NousAccountInFlightGateOptions {
  maxInFlight: number;
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
  readonly #inFlightCallMs: number[] = [];

  constructor(options: NousAccountInFlightGateOptions) {
    if (!Number.isInteger(options.maxInFlight) || options.maxInFlight < 1) {
      throw new Error(
        `NousAccountInFlightGate: maxInFlight must be a positive integer, got ${options.maxInFlight}`,
      );
    }
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
        timer = setTimeout(() => waiter.drop(), Math.max(0, budgetMs - callMs));
      }
    });
  }

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
