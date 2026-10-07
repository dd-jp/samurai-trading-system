import type {
  BrokerBook,
  BrokerBookReader,
  BrokerOpenOrder,
  BrokerPosition,
  Venue,
} from '../../../../contracts/index.js';
import type { AlpacaBrokerClient, AlpacaOrder, AlpacaOrderLeg } from './alpaca/alpaca-client.js';
import { ALPACA_ORDER_HISTORY_LIMIT } from './alpaca/alpaca-http-client.js';

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

function legSide(symbol: string, leg: AlpacaOrderLeg): 'buy' | 'sell' {
  if (leg.side === 'buy' || leg.side === 'sell') return leg.side;
  throw new Error(`Alpaca ${symbol} held stop ${leg.id} side ${leg.side} is not buy or sell`);
}

function legAsOrder(parent: AlpacaOrder, leg: AlpacaOrderLeg): AlpacaOrder {
  return {
    ...leg,
    client_order_id: leg.client_order_id ?? leg.id,
    symbol: parent.symbol,
    side: legSide(parent.symbol, leg),
    qty: leg.qty ?? '',
    order_class: parent.order_class,
  };
}

// Measured on Alpaca paper 2026-10-07 (#2086): `status=open` leaves out `held` orders, and a filled
// bracket's stop leg stays `held` at the venue while its take-profit rests `new`. Alpaca documents a
// bracket's legs as inactive until the parent fills. An OCO re-arm's held stop is assumed to guard
// while its take-profit parent is live; that wire is unmeasured
const ENDED_ORDER_STATES: ReadonlySet<string> = new Set([
  'canceled',
  'filled',
  'expired',
  'replaced',
  'rejected',
  'done_for_day',
]);

function guardingParent(parent: AlpacaOrder): boolean {
  if (parent.order_class === 'oco') return !ENDED_ORDER_STATES.has(parent.status);
  return parent.status === 'filled';
}

function heldStopLegs(parent: AlpacaOrder): AlpacaOrder[] {
  if (!guardingParent(parent)) return [];
  return (parent.legs ?? [])
    .filter((leg) => leg.status === 'held' && PROTECTIVE_STOP_TYPES.has(leg.type))
    .map((leg) => legAsOrder(parent, leg));
}

// Measured on Alpaca paper 2026-10-07 (#2086): with `nested=true` the limit counts legs as well as
// parents, and a page it cuts short lists a leg whose parent fell outside it as an order of its own
function flatOrderCount(history: readonly AlpacaOrder[]): number {
  return history.reduce((count, order) => count + 1 + (order.legs?.length ?? 0), 0);
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
    const heldStops = await this.heldStops([...held], orders);
    return {
      positions: signed,
      openOrders: [...orders, ...heldStops].map(openOrder(held)),
      cashQuote: finite(account.cash, 'cash'),
    };
  }

  private async heldStops(
    symbols: readonly string[],
    listed: readonly AlpacaOrder[],
  ): Promise<AlpacaOrder[]> {
    if (symbols.length === 0) return [];
    const history = await this.client.listOrderHistory(symbols);
    if (flatOrderCount(history) >= ALPACA_ORDER_HISTORY_LIMIT) {
      throw new Error(
        `Alpaca order history for ${symbols.join(',')} filled its ${ALPACA_ORDER_HISTORY_LIMIT}-order page: a held stop past it would go unread`,
      );
    }
    const listedIds = new Set(listed.map((order) => order.id));
    return history.flatMap(heldStopLegs).filter((leg) => !listedIds.has(leg.id));
  }
}

export const NO_BROKER_BOOKS: BrokerBookReader = {
  read: (venue) =>
    Promise.reject(new Error(`no broker book reader for ${venue}: every route is simulated`)),
};
