import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../../pipeline/execution/index.js';
import { saxoFillCost } from '../../pipeline/momentum/index.js';
import type { Clock } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';

export interface SaxoPaperAdapterOptions {
  readonly clock: Clock;
  readonly halfSpreadBps: (instrument: string) => number;
}

interface PaperPosition {
  qty: number;
  side: 'buy' | 'sell';
  avgEntry: number;
}

function slipped(price: number, side: 'buy' | 'sell', halfSpreadBps: number): number {
  const fraction = halfSpreadBps / 10_000;
  return side === 'buy' ? price * (1 + fraction) : price * (1 - fraction);
}

export class SaxoPaperBrokerAdapter implements BrokerAdapter {
  readonly prices_own_fills = true;
  readonly #fills: NormalizedFill[] = [];
  readonly #orders = new Map<string, NormalizedOrder>();
  readonly #positions = new Map<string, PaperPosition>();

  constructor(private readonly options: SaxoPaperAdapterOptions) {}

  submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    if (!(order.size > 0) || !(order.entry > 0)) {
      return Promise.reject(
        new Error(`SaxoPaperBrokerAdapter: bad bracket ${order.client_order_id}`),
      );
    }
    const price = slipped(order.entry, order.side, this.options.halfSpreadBps(order.instrument));
    this.#fill(order.client_order_id, order.instrument, order.side, order.size, price, 'entry');
    return Promise.resolve(this.#ack(order.client_order_id, order.size));
  }

  getOrder(clientOrderId: string): Promise<NormalizedOrder | null> {
    return Promise.resolve(this.#orders.get(clientOrderId) ?? null);
  }

  resumeFlatten(clientOrderId: string): Promise<NormalizedOrder | null> {
    return this.getOrder(clientOrderId);
  }

  fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    return Promise.resolve(this.#fills.filter((fill) => fill.timestamp > since));
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
    const position = this.#positions.get(instrument);
    if (position === undefined || !(size > 0) || position.qty < size) {
      return Promise.reject(
        new Error(`SaxoPaperBrokerAdapter: nothing to flatten in ${instrument}`),
      );
    }
    const price = slipped(position.avgEntry, side, this.options.halfSpreadBps(instrument));
    this.#fill(clientOrderId, instrument, side, size, price, 'exit');
    return Promise.resolve(this.#ack(clientOrderId, size));
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  getOpenPositions(): Promise<NormalizedPosition[]> {
    return Promise.resolve(
      [...this.#positions.entries()]
        .filter(([, position]) => position.qty > 0)
        .map(([instrument, position]) => ({
          instrument,
          qty: position.qty,
          side: position.side,
          avg_entry_price: position.avgEntry,
        })),
    );
  }

  #ack(clientOrderId: string, size: number): BrokerAck {
    this.#orders.set(clientOrderId, {
      client_order_id: clientOrderId,
      broker_order_ids: [`saxo-paper-${clientOrderId}`],
      order_state: 'filled',
      filled_qty: size,
    });
    return {
      client_order_id: clientOrderId,
      broker_order_ids: [`saxo-paper-${clientOrderId}`],
      order_state: 'filled',
    };
  }

  #fill(
    clientOrderId: string,
    instrument: string,
    side: 'buy' | 'sell',
    qty: number,
    price: number,
    leg: 'entry' | 'exit',
  ): void {
    const notional = price * qty;
    this.#fills.push({
      client_order_id: clientOrderId,
      broker_fill_id: toBrokerFillId(`saxo-paper-fill-${this.#fills.length + 1}`),
      leg,
      price,
      qty,
      fee: saxoFillCost({ side, notional, shares: qty, halfSpreadBps: 0 }),
      fee_currency: 'GBP',
      timestamp: this.options.clock.now(),
    });
    this.#applyToPosition(instrument, side, qty, price, leg);
  }

  #applyToPosition(
    instrument: string,
    side: 'buy' | 'sell',
    qty: number,
    price: number,
    leg: 'entry' | 'exit',
  ): void {
    const existing = this.#positions.get(instrument);
    if (leg === 'entry') {
      const prior = existing?.qty ?? 0;
      const avgEntry =
        prior === 0 ? price : ((existing?.avgEntry ?? 0) * prior + price * qty) / (prior + qty);
      this.#positions.set(instrument, { qty: prior + qty, side, avgEntry });
      return;
    }
    if (existing !== undefined) existing.qty = Math.max(0, existing.qty - qty);
  }
}
