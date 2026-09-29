import type {
  BrokerBook,
  BrokerBookReader,
  BrokerPosition,
  Venue,
} from '../../../../contracts/index.js';
import type { AlpacaBrokerClient } from '../../../pipeline/execution/index.js';

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
      openOrders: orders.map((order) => ({
        clientOrderId: order.client_order_id,
        instrument: order.symbol,
      })),
      cashQuote: finite(account.cash, 'cash'),
    };
  }
}

export const NO_BROKER_BOOKS: BrokerBookReader = {
  read: (venue) =>
    Promise.reject(new Error(`no broker book reader for ${venue}: every route is simulated`)),
};
