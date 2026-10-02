import type {
  BrokerBook,
  BrokerBookReader,
  BrokerOpenOrder,
  BrokerPosition,
  Venue,
} from '../../../../contracts/index.js';
import type { AlpacaBrokerClient, AlpacaOrder } from '../../../pipeline/execution/index.js';

function finite(value: string, what: string): number {
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isFinite(parsed)) {
    throw new Error(`Alpaca ${what} ${JSON.stringify(value)} is not a number`);
  }
  return parsed;
}

function signedPosition(position: {
  symbol: string;
  qty: string;
  side: 'long' | 'short';
}): BrokerPosition {
  const qty = Math.abs(finite(position.qty, `${position.symbol} qty`));
  return { instrument: position.symbol, qty: position.side === 'short' ? -qty : qty };
}

const PROTECTIVE_STOP_TYPES: ReadonlySet<string | undefined> = new Set(['stop', 'stop_limit']);

function unknownOrder(order: AlpacaOrder): BrokerOpenOrder {
  return {
    clientOrderId: order.client_order_id,
    instrument: order.symbol,
    protects: null,
    qty: null,
    stopPrice: null,
  };
}

// A stop part-filled on an earlier session guards only what it has left to sell
function stopOrder(order: AlpacaOrder): BrokerOpenOrder {
  const what = `${order.symbol} stop ${order.client_order_id}`;
  const qty = finite(order.qty ?? '', `${what} qty`);
  return {
    clientOrderId: order.client_order_id,
    instrument: order.symbol,
    protects: order.side === 'sell' ? 'long' : 'short',
    qty: qty - finite(order.filled_qty ?? '', `${what} filled qty`),
    stopPrice: finite(order.stop_price ?? '', `${what} stop price`),
  };
}

// A stop the reader cannot size or price fails the read only where the account holds the name;
// elsewhere it guards nothing and reconcile names it as an order the store does not know
function openOrder(held: ReadonlySet<string>): (order: AlpacaOrder) => BrokerOpenOrder {
  return (order) => {
    if (!PROTECTIVE_STOP_TYPES.has(order.type)) return unknownOrder(order);
    if (held.has(order.symbol)) return stopOrder(order);
    try {
      return stopOrder(order);
    } catch {
      return unknownOrder(order);
    }
  };
}

export class AlpacaBrokerBooks implements BrokerBookReader {
  constructor(private readonly client: AlpacaBrokerClient) {}

  async read(venue: Venue): Promise<BrokerBook> {
    if (venue !== 'alpaca') throw new Error(`no broker book reader for ${venue}`);
    const [positions, orders, account] = await Promise.all([
      this.client.getPositions(),
      this.client.listOpenOrders(),
      this.client.getAccount(),
    ]);
    const signed = positions.map(signedPosition);
    const held = new Set(signed.filter((position) => position.qty !== 0).map((p) => p.instrument));
    return {
      positions: signed,
      openOrders: orders.map(openOrder(held)),
      cashQuote: finite(account.cash, 'cash'),
    };
  }
}

export const NO_BROKER_BOOKS: BrokerBookReader = {
  read: (venue) =>
    Promise.reject(new Error(`no broker book reader for ${venue}: every route is simulated`)),
};
