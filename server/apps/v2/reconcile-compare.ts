import type { BrokerOpenOrder, ReconcileDiff } from '../../../contracts/index.js';
import { tickFor } from './execution/index.js';

export interface VenueView {
  readonly positions: ReadonlyMap<string, number>;
  readonly openOrders: readonly BrokerOpenOrder[];
  readonly cashGbp: number;
}

export interface HeldProtection {
  readonly entryOrderIds: readonly string[];
  readonly stops: readonly number[];
}

export interface StoreView extends VenueView {
  readonly protection: ReadonlyMap<string, HeldProtection>;
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

function matchedHoldings(store: VenueView, broker: VenueView): [string, number][] {
  return [...store.positions].filter(
    ([instrument, held]) => held !== 0 && sameQty(held, broker.positions.get(instrument) ?? 0),
  );
}

function isGuarded(broker: VenueView): (holding: [string, number]) => boolean {
  const guarded = guardedPositions(broker);
  return ([instrument, held]) => guarded.has(guardKey(instrument, heldSide(held)));
}

function unprotectedDiffs(store: VenueView, broker: VenueView): ReconcileDiff[] {
  const guarded = isGuarded(broker);
  return matchedHoldings(store, broker)
    .filter((holding) => !guarded(holding))
    .map(([instrument, held]) =>
      diff('position_unprotected', {
        instrument,
        store: held,
        broker: broker.positions.get(instrument) ?? 0,
      }),
    );
}

function closingStops(broker: VenueView, instrument: string, held: number): BrokerOpenOrder[] {
  return broker.openOrders.filter(
    (order) => order.instrument === instrument && order.protects === heldSide(held),
  );
}

// An entry or add-on still open at the venue is filling: its bracket stop is sized for the whole
// order and rests beside the held position's
function entryWorking(store: StoreView, broker: VenueView, instrument: string): boolean {
  const working = new Set(broker.openOrders.map((order) => order.clientOrderId));
  const entries = [
    ...(store.protection.get(instrument)?.entryOrderIds ?? []),
    ...store.openOrders
      .filter((order) => order.instrument === instrument)
      .map((order) => order.clientOrderId),
  ];
  return entries.some((id) => working.has(id));
}

// David 2026-10-02 (#1990): an unguarded holding is re-armed at its journalled stop, unless an entry
// still filling owns its protection
export function rearmable(store: StoreView, broker: VenueView): (instrument: string) => boolean {
  return (instrument) =>
    (store.protection.get(instrument)?.stops.length ?? 0) > 0 &&
    !entryWorking(store, broker, instrument);
}

// A split the venue did not apply to its resting stop leaves the stop sized and priced for the
// pre-split share: a forward split sells only part of the position, a reverse one oversells into
// a short (#1990). A null qty or price is one the venue's reader does not report; the Alpaca
// reader refuses a stop without either
function stopQtyDiff(instrument: string, held: number, stops: BrokerOpenOrder[]): ReconcileDiff[] {
  if (stops.some((order) => order.qty === null)) return [];
  const covered = stops.reduce((sum, order) => sum + (order.qty as number), 0);
  if (sameQty(covered, Math.abs(held))) return [];
  return [diff('protective_qty', { instrument, store: Math.abs(held), broker: covered })];
}

// Two ticks: the venue snaps the submitted stop onto its grid, and a venue that adjusts its own
// orders for a split rounds the divided price again; a split moves the price by 20% or more
const STOP_TICKS = 2;
// Ticks are compared to a millionth so the float noise of a price minus a level never decides it
const TICK_SCALE = 1e6;

function matchesALevel(stopPrice: number, levels: readonly number[]): boolean {
  return levels.some(
    (level) =>
      Math.round((Math.abs(stopPrice - level) / tickFor(level)) * TICK_SCALE) <=
      STOP_TICKS * TICK_SCALE,
  );
}

function stopPriceDiffs(
  instrument: string,
  stops: BrokerOpenOrder[],
  levels: readonly number[],
): ReconcileDiff[] {
  if (levels.length === 0) return [];
  return stops
    .filter((order) => order.stopPrice !== null && !matchesALevel(order.stopPrice, levels))
    .map((order) =>
      diff('protective_price', {
        instrument,
        order_id: order.clientOrderId,
        store: levels[0] as number,
        broker: order.stopPrice,
      }),
    );
}

function protectiveDiffs(store: StoreView, broker: VenueView): ReconcileDiff[] {
  return matchedHoldings(store, broker)
    .filter(isGuarded(broker))
    .flatMap(([instrument, held]) => {
      if (entryWorking(store, broker, instrument)) return [];
      const stops = closingStops(broker, instrument, held);
      return [
        ...stopQtyDiff(instrument, held, stops),
        ...stopPriceDiffs(instrument, stops, store.protection.get(instrument)?.stops ?? []),
      ];
    });
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

export function compareVenue(store: StoreView, broker: VenueView, cash: CashRule): ReconcileDiff[] {
  return [
    ...positionDiffs(store, broker),
    ...unprotectedDiffs(store, broker),
    ...protectiveDiffs(store, broker),
    ...orderDiffs(store, broker),
    ...cashDiffs(store, broker, cash),
  ];
}
