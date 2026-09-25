import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../../pipeline/execution/index.js';

export interface RefusedSubmission {
  readonly client_order_id: string;
  readonly instrument: string;
  readonly kind: 'bracket' | 'flatten';
  readonly payload: Record<string, unknown>;
}

export class DryRunRefusedError extends Error {
  constructor(readonly submission: RefusedSubmission) {
    super(`dry run refused ${submission.kind} ${submission.client_order_id}`);
    this.name = 'DryRunRefusedError';
  }
}

export class DryRunBrokerAdapter implements BrokerAdapter {
  readonly prices_own_fills = true;
  readonly refused: RefusedSubmission[] = [];

  submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    return this.#refuse({
      client_order_id: order.client_order_id,
      instrument: order.instrument,
      kind: 'bracket',
      payload: { ...order },
    });
  }

  getOrder(): Promise<NormalizedOrder | null> {
    return Promise.resolve(null);
  }

  resumeFlatten(): Promise<NormalizedOrder | null> {
    return Promise.resolve(null);
  }

  fetchNewFills(): Promise<NormalizedFill[]> {
    return Promise.resolve([]);
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
    return this.#refuse({
      client_order_id: clientOrderId,
      instrument,
      kind: 'flatten',
      payload: { side, size },
    });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  getOpenPositions(): Promise<NormalizedPosition[]> {
    return Promise.resolve([]);
  }

  #refuse(submission: RefusedSubmission): Promise<BrokerAck> {
    this.refused.push(submission);
    return Promise.reject(new DryRunRefusedError(submission));
  }
}
