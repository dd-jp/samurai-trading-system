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

function stopOrder(order: AlpacaOrder): BrokerOpenOrder {
  const what = `${order.symbol} stop ${order.client_order_id}`;
  return {
    clientOrderId: order.client_order_id,
    instrument: order.symbol,
    protects: order.side === 'sell' ? 'long' : 'short',
    qty: finite(order.qty ?? '', `${what} qty`),
    stopPrice: finite(order.stop_price ?? '', `${what} stop price`),
  };
}

function openOrder(order: AlpacaOrder): BrokerOpenOrder {
  if (PROTECTIVE_STOP_TYPES.has(order.type)) return stopOrder(order);
  return {
    clientOrderId: order.client_order_id,
    instrument: order.symbol,
    protects: null,
    qty: null,
    stopPrice: null,
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
    return {
      positions: positions.map(signedPosition),
      openOrders: orders.map(openOrder),
      cashQuote: finite(account.cash, 'cash'),
    };
  }
}

export const NO_BROKER_BOOKS: BrokerBookReader = {
  read: (venue) =>
    Promise.reject(new Error(`no broker book reader for ${venue}: every route is simulated`)),
};
