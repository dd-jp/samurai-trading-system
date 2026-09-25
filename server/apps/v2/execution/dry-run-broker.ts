import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../../../pipeline/execution/index.js';
import type { Clock } from '../../../shared/index.js';
import { toBrokerFillId } from '../../../shared/index.js';

export interface RefusedSubmission {
  readonly client_order_id: string;
  readonly instrument: string;
  readonly kind: 'bracket' | 'flatten';
}

export class DryRunRefusedError extends Error {
  constructor(readonly submission: RefusedSubmission) {
    super(`dry run refused ${submission.kind} ${submission.client_order_id}`);
    this.name = 'DryRunRefusedError';
  }
}

export interface DryRunBrokerDeps {
  readonly halfSpreadBps: (instrument: string) => number;
  readonly markPrice: (instrument: string) => number | undefined;
  readonly clock: Clock;
}

const BPS = 10_000;

export function spreadAdjusted(price: number, side: 'buy' | 'sell', halfSpreadBps: number): number {
  const adjustment = (price * halfSpreadBps) / BPS;
  return side === 'buy' ? price + adjustment : price - adjustment;
}

export class DryRunBrokerAdapter implements BrokerAdapter {
  readonly prices_own_fills = true;
  readonly #pending: NormalizedFill[] = [];

  constructor(private readonly deps: DryRunBrokerDeps) {}

  submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    this.#queue(
      order.client_order_id,
      'entry',
      order.size,
      spreadAdjusted(order.entry, order.side, this.deps.halfSpreadBps(order.instrument)),
    );
    return this.#refuse({
      client_order_id: order.client_order_id,
      instrument: order.instrument,
      kind: 'bracket',
    });
  }

  getOrder(): Promise<NormalizedOrder | null> {
    return Promise.resolve(null);
  }

  resumeFlatten(): Promise<NormalizedOrder | null> {
    return Promise.resolve(null);
  }

  fetchNewFills(_since: Date): Promise<NormalizedFill[]> {
    return Promise.resolve(this.#pending.splice(0));
  }

  resizeProtectiveLegs(): Promise<void> {
    return Promise.resolve();
  }

  rearmProtectiveLegs(): Promise<void> {
    return Promise.resolve();
  }

  submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    const mark = this.deps.markPrice(instrument);
    if (mark !== undefined) {
      this.#queue(
        clientOrderId,
        'exit',
        size,
        spreadAdjusted(mark, side, this.deps.halfSpreadBps(instrument)),
      );
    }
    return this.#refuse({ client_order_id: clientOrderId, instrument, kind: 'flatten' });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  getOpenPositions(): Promise<NormalizedPosition[]> {
    return Promise.resolve([]);
  }

  #queue(clientOrderId: string, leg: 'entry' | 'exit', qty: number, price: number): void {
    this.#pending.push({
      client_order_id: clientOrderId,
      broker_fill_id: toBrokerFillId(`dry-${clientOrderId}-${leg}`),
      leg,
      price,
      qty,
      fee: 0,
      timestamp: this.deps.clock.now(),
    });
  }

  #refuse(submission: RefusedSubmission): Promise<BrokerAck> {
    return Promise.reject(new DryRunRefusedError(submission));
  }
}
