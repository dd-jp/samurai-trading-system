import type { BrokerOpenOrder, ReconcileDiff } from '../../../contracts/index.js';

export interface VenueView {
  readonly positions: ReadonlyMap<string, number>;
  readonly openOrders: readonly BrokerOpenOrder[];
  readonly cashGbp: number;
}

// Alpaca reports fractional qty to 9 decimals; rounding there drops the float noise of summing
// fills across books without letting any real share difference through
const QTY_SCALE = 1e9;

function sameQty(a: number, b: number): boolean {
  return Math.round(a * QTY_SCALE) === Math.round(b * QTY_SCALE);
}

function positionKind(store: number, broker: number): ReconcileDiff['kind'] {
  if (store === 0) return 'position_missing_in_store';
  if (broker === 0) return 'position_missing_at_broker';
  return 'position_qty';
}

function diff(
  kind: ReconcileDiff['kind'],
  fields: Partial<Omit<ReconcileDiff, 'kind'>> = {},
): ReconcileDiff {
  return {
    kind,
    instrument: fields.instrument ?? null,
    order_id: fields.order_id ?? null,
    store: fields.store ?? null,
    broker: fields.broker ?? null,
  };
}

function positionDiffs(store: VenueView, broker: VenueView): ReconcileDiff[] {
  const instruments = [...new Set([...store.positions.keys(), ...broker.positions.keys()])].sort();
  const diffs: ReconcileDiff[] = [];
  for (const instrument of instruments) {
    const held = store.positions.get(instrument) ?? 0;
    const reported = broker.positions.get(instrument) ?? 0;
    if (sameQty(held, reported)) continue;
    diffs.push(diff(positionKind(held, reported), { instrument, store: held, broker: reported }));
  }
  return diffs;
}

const guardKey = (instrument: string, side: 'long' | 'short'): string => `${instrument}|${side}`;

function heldSide(qty: number): 'long' | 'short' {
  return qty > 0 ? 'long' : 'short';
}

// Only a resting stop on the closing side guards a position; an add-on entry resting on the same
// name would otherwise pass for one
function guardedPositions(broker: VenueView): ReadonlySet<string> {
  return new Set(
    broker.openOrders.flatMap((order) =>
      order.protects === null ? [] : [guardKey(order.instrument, order.protects)],
    ),
  );
}

function unprotectedDiffs(store: VenueView, broker: VenueView): ReconcileDiff[] {
  const guarded = guardedPositions(broker);
  const diffs: ReconcileDiff[] = [];
  for (const [instrument, held] of store.positions) {
    const reported = broker.positions.get(instrument) ?? 0;
    if (held === 0 || !sameQty(held, reported)) continue;
    if (guarded.has(guardKey(instrument, heldSide(held)))) continue;
    diffs.push(diff('position_unprotected', { instrument, store: held, broker: reported }));
  }
  return diffs;
}

function orderDiffs(store: VenueView, broker: VenueView): ReconcileDiff[] {
  const atBroker = new Set(broker.openOrders.map((order) => order.clientOrderId));
  const known = new Set([
    ...store.positions.keys(),
    ...store.openOrders.map((order) => order.instrument),
  ]);
  const missing = store.openOrders
    .filter((order) => !atBroker.has(order.clientOrderId))
    .map((order) =>
      diff('order_missing_at_broker', {
        instrument: order.instrument,
        order_id: order.clientOrderId,
      }),
    );
  const unknown = broker.openOrders
    .filter((order) => !known.has(order.instrument))
    .map((order) =>
      diff('order_unknown_to_store', {
        instrument: order.instrument,
        order_id: order.clientOrderId,
      }),
    );
  return [...missing, ...unknown];
}

export type CashRule = 'not_compared' | { readonly toleranceGbp: number | undefined };

function cashDiffs(store: VenueView, broker: VenueView, rule: CashRule): ReconcileDiff[] {
  if (rule === 'not_compared') return [];
  const amounts = { store: store.cashGbp, broker: broker.cashGbp };
  if (rule.toleranceGbp === undefined) return [diff('cash_unverified', amounts)];
  if (Math.abs(store.cashGbp - broker.cashGbp) <= rule.toleranceGbp) return [];
  return [diff('cash', amounts)];
}

export function compareVenue(store: VenueView, broker: VenueView, cash: CashRule): ReconcileDiff[] {
  return [
    ...positionDiffs(store, broker),
    ...unprotectedDiffs(store, broker),
    ...orderDiffs(store, broker),
    ...cashDiffs(store, broker, cash),
  ];
}
