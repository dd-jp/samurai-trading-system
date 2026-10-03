import { describe, expect, it } from 'vitest';
import type { BrokerOpenOrder } from '../../../contracts/index.js';
import {
  compareVenue,
  type HeldProtection,
  rearmable,
  type StoreView,
} from './reconcile-compare.js';

function view(
  positions: Record<string, number>,
  openOrders: readonly BrokerOpenOrder[] = [],
  protection: Record<string, HeldProtection> = {},
): StoreView {
  return {
    positions: new Map(Object.entries(positions)),
    openOrders,
    protection: new Map(Object.entries(protection)),
  };
}

const stop = (
  instrument: string,
  clientOrderId = `stop-${instrument}`,
  protects: BrokerOpenOrder['protects'] = 'long',
  sized: Pick<BrokerOpenOrder, 'qty' | 'stopPrice'> = { qty: null, stopPrice: null },
): BrokerOpenOrder => ({ clientOrderId, instrument, protects, ...sized });

describe('compareVenue', () => {
  it('finds nothing when positions and orders agree', () => {
    const store = view({ AAPL: 6, MSFT: -3 }, [stop('NVDA', 'entry-nvda')]);
    const broker = view({ AAPL: 6, MSFT: -3 }, [
      stop('AAPL'),
      stop('MSFT', 'stop-MSFT', 'short'),
      stop('NVDA', 'entry-nvda'),
    ]);
    expect(compareVenue(store, broker)).toEqual([]);
  });

  it('names a broker position the store does not hold', () => {
    expect(compareVenue(view({}), view({ MSFT: 5 }, [stop('MSFT')]))).toEqual([
      {
        kind: 'position_missing_in_store',
        instrument: 'MSFT',
        order_id: null,
        store: 0,
        broker: 5,
      },
      {
        kind: 'order_unknown_to_store',
        instrument: 'MSFT',
        order_id: 'stop-MSFT',
        store: null,
        broker: null,
      },
    ]);
  });

  it('names a store position the broker does not hold, without also calling it unprotected', () => {
    expect(compareVenue(view({ AAPL: 6 }), view({}))).toEqual([
      {
        kind: 'position_missing_at_broker',
        instrument: 'AAPL',
        order_id: null,
        store: 6,
        broker: 0,
      },
    ]);
  });

  it('names a quantity that differs on both sides, short or long', () => {
    expect(
      compareVenue(
        view({ AAPL: 6, MSFT: -3 }),
        view({ AAPL: 4, MSFT: -2 }, [stop('AAPL'), stop('MSFT')]),
      ),
    ).toEqual([
      { kind: 'position_qty', instrument: 'AAPL', order_id: null, store: 6, broker: 4 },
      { kind: 'position_qty', instrument: 'MSFT', order_id: null, store: -3, broker: -2 },
    ]);
  });

  it('treats a long and a short of the same size as different', () => {
    expect(compareVenue(view({ AAPL: 6 }), view({ AAPL: -6 }, [stop('AAPL')]))).toEqual([
      { kind: 'position_qty', instrument: 'AAPL', order_id: null, store: 6, broker: -6 },
    ]);
  });

  it('matches exactly: float noise from summing fractional fills is not a difference, a billionth of a share is', () => {
    const summed = 0.1 + 0.2;
    expect(compareVenue(view({ AAPL: summed }), view({ AAPL: 0.3 }, [stop('AAPL')]))).toEqual([]);
    expect(compareVenue(view({ AAPL: 0.3 }), view({ AAPL: 0.300000001 }, [stop('AAPL')]))).toEqual([
      { kind: 'position_qty', instrument: 'AAPL', order_id: null, store: 0.3, broker: 0.300000001 },
    ]);
  });

  it('lists position differences in instrument order', () => {
    const kinds = compareVenue(view({ ZZ: 1, AA: 1 }), view({ MM: 1 }))
      .filter((entry) => entry.kind.startsWith('position_missing'))
      .map((entry) => entry.instrument);
    expect(kinds).toEqual(['AA', 'MM', 'ZZ']);
  });

  it('flags a held position that matches but has no open order guarding it at the broker', () => {
    expect(compareVenue(view({ AAPL: 6 }), view({ AAPL: 6 }))).toEqual([
      { kind: 'position_unprotected', instrument: 'AAPL', order_id: null, store: 6, broker: 6 },
    ]);
  });

  it('takes only a stop on the closing side as a guard, never a resting add-on entry', () => {
    const held = { AAPL: 6, MSFT: -3 };
    const unguarded = [
      { kind: 'position_unprotected', instrument: 'AAPL', order_id: null, store: 6, broker: 6 },
      { kind: 'position_unprotected', instrument: 'MSFT', order_id: null, store: -3, broker: -3 },
    ];
    const addOns = [stop('AAPL', 'add-aapl', null), stop('MSFT', 'add-msft', null)];
    expect(compareVenue(view(held), view(held, addOns))).toEqual(unguarded);
    const wrongSide = [stop('AAPL', 'buy-stop', 'short'), stop('MSFT', 'sell-stop', 'long')];
    expect(compareVenue(view(held), view(held, wrongSide))).toEqual(unguarded);
    const closing = [stop('AAPL', 'sell-stop', 'long'), stop('MSFT', 'buy-stop', 'short')];
    expect(compareVenue(view(held), view(held, closing))).toEqual([]);
  });

  it('does not call a position unprotected when books net it flat and the broker holds none', () => {
    expect(compareVenue(view({ AAPL: 0 }), view({}))).toEqual([]);
  });

  it("does not take an order on another name as a position's guard", () => {
    expect(
      compareVenue(view({ AAPL: 6, MSFT: 1 }), view({ AAPL: 6, MSFT: 1 }, [stop('MSFT')])),
    ).toEqual([
      { kind: 'position_unprotected', instrument: 'AAPL', order_id: null, store: 6, broker: 6 },
    ]);
  });

  it('names a resting store entry the broker has no open order for', () => {
    expect(compareVenue(view({}, [stop('NVDA', 'entry-nvda')]), view({}))).toEqual([
      {
        kind: 'order_missing_at_broker',
        instrument: 'NVDA',
        order_id: 'entry-nvda',
        store: null,
        broker: null,
      },
    ]);
  });

  it('matches resting entries by client order id, not by name', () => {
    expect(
      compareVenue(view({}, [stop('NVDA', 'entry-nvda')]), view({}, [stop('NVDA', 'other')])),
    ).toEqual([
      {
        kind: 'order_missing_at_broker',
        instrument: 'NVDA',
        order_id: 'entry-nvda',
        store: null,
        broker: null,
      },
    ]);
  });

  it('accepts a broker order on a name the store rests an entry on or holds', () => {
    const store = view({ AAPL: 6 }, [stop('NVDA', 'entry-nvda')]);
    const broker = view({ AAPL: 6 }, [
      stop('NVDA', 'entry-nvda'),
      stop('NVDA', 'nvda-leg'),
      stop('AAPL'),
    ]);
    expect(compareVenue(store, broker)).toEqual([]);
  });

  it('names a broker open order on a name the store neither holds nor rests an entry on', () => {
    expect(compareVenue(view({}), view({}, [stop('TSLA', 'foreign')]))).toEqual([
      {
        kind: 'order_unknown_to_store',
        instrument: 'TSLA',
        order_id: 'foreign',
        store: null,
        broker: null,
      },
    ]);
  });

  it('reports every kind of difference at once, positions first', () => {
    const kinds = compareVenue(
      view({ AAPL: 6, MSFT: 2 }, [stop('NVDA', 'entry-nvda')]),
      view({ AAPL: 6, MSFT: 1 }, [stop('TSLA', 'foreign')]),
    ).map((entry) => entry.kind);
    expect(kinds).toEqual([
      'position_qty',
      'position_unprotected',
      'order_missing_at_broker',
      'order_unknown_to_store',
    ]);
  });
});

describe('compareVenue: the protective stop against the position (#1990)', () => {
  const sized = (qty: number | null, stopPrice: number | null = null) => ({ qty, stopPrice });
  const aapl = (stops: readonly number[], entryOrderIds: readonly string[] = ['entry-aapl']) => ({
    AAPL: { entryOrderIds, stops },
  });
  const store = (qty: number, stops: readonly number[] = []) =>
    view({ AAPL: qty }, [], aapl(stops));
  const broker = (qty: number, ...orders: BrokerOpenOrder[]) => view({ AAPL: qty }, orders);

  it('is clean when the closing-side stops cover the position and sit at a held entry stop', () => {
    expect(
      compareVenue(
        store(151, [60, 61]),
        broker(
          151,
          stop('AAPL', 'leg-a', 'long', sized(100, 60.02)),
          stop('AAPL', 'leg-b', 'long', sized(51, 61)),
        ),
      ),
    ).toEqual([]);
  });

  it('names a stop left at the pre-split 101 shares after a 3:2 forward split, and its stale price', () => {
    expect(
      compareVenue(store(151, [60]), broker(151, stop('AAPL', 'leg', 'long', sized(101, 90)))),
    ).toEqual([
      { kind: 'protective_qty', instrument: 'AAPL', order_id: null, store: 151, broker: 101 },
      { kind: 'protective_price', instrument: 'AAPL', order_id: 'leg', store: 60, broker: 90 },
    ]);
  });

  it('names a stop that would oversell into a short after a 1:2 reverse split', () => {
    expect(
      compareVenue(store(50, [180]), broker(50, stop('AAPL', 'leg', 'long', sized(101, 90)))),
    ).toEqual([
      { kind: 'protective_qty', instrument: 'AAPL', order_id: null, store: 50, broker: 101 },
      { kind: 'protective_price', instrument: 'AAPL', order_id: 'leg', store: 180, broker: 90 },
    ]);
  });

  it('compares a short against its buy stops only, by absolute qty', () => {
    const short = view({ AAPL: -30 }, [], aapl([]));
    const orders = [
      stop('AAPL', 'buy-stop', 'short', sized(30)),
      stop('AAPL', 'sell-stop', 'long', sized(7)),
    ];
    expect(compareVenue(short, view({ AAPL: -30 }, orders))).toEqual([]);
    expect(
      compareVenue(
        short,
        view({ AAPL: -30 }, [orders[0] as BrokerOpenOrder, stop('AAPL', 'x', 'short', sized(1))]),
      ),
    ).toEqual([
      { kind: 'protective_qty', instrument: 'AAPL', order_id: null, store: 30, broker: 31 },
    ]);
  });

  it('accepts a stop two ticks from the held stop and names one past it', () => {
    const at = (price: number) =>
      compareVenue(store(10, [60]), broker(10, stop('AAPL', 'leg', 'long', sized(10, price))));
    expect(at(59.98)).toEqual([]);
    expect(at(60.02)).toEqual([]);
    expect(at(60.03)).toMatchObject([{ kind: 'protective_price', broker: 60.03 }]);
    expect(at(59.97)).toMatchObject([{ kind: 'protective_price', broker: 59.97 }]);
    const penny = (price: number) =>
      compareVenue(store(10, [0.5]), broker(10, stop('AAPL', 'leg', 'long', sized(10, price))));
    expect(penny(0.5002)).toEqual([]);
    expect(penny(0.5003)).toMatchObject([{ kind: 'protective_price' }]);
  });

  it('checks the position even when another name has an entry working', () => {
    const other = stop('MSFT', 'entry-msft', null, sized(null));
    expect(
      compareVenue(
        view({ AAPL: 151 }, [other], aapl([60])),
        broker(151, other, stop('AAPL', 'leg', 'long', sized(101, 60))),
      ),
    ).toEqual([
      { kind: 'protective_qty', instrument: 'AAPL', order_id: null, store: 151, broker: 101 },
    ]);
  });

  it('skips the qty when any stop on the name has none reported, and a price with no held protection', () => {
    expect(
      compareVenue(
        store(151, [60]),
        broker(
          151,
          stop('AAPL', 'leg-a', 'long', sized(null, 60)),
          stop('AAPL', 'leg-b', 'long', sized(50, 60)),
        ),
      ),
    ).toEqual([]);
    expect(
      compareVenue(view({ AAPL: 151 }), broker(151, stop('AAPL', 'leg', 'long', sized(151, 90)))),
    ).toEqual([]);
  });

  it('skips a qty or price the venue reader does not report, and a price with no held entry stop', () => {
    expect(
      compareVenue(store(151, [60]), broker(151, stop('AAPL', 'leg', 'long', sized(null, 60)))),
    ).toEqual([]);
    expect(
      compareVenue(store(151, [60]), broker(151, stop('AAPL', 'leg', 'long', sized(151)))),
    ).toEqual([]);
    expect(
      compareVenue(store(151), broker(151, stop('AAPL', 'leg', 'long', sized(151, 90)))),
    ).toEqual([]);
  });

  it('skips a position whose entry is still working at the venue, its stop sized for the whole order', () => {
    const working = broker(
      40,
      stop('AAPL', 'entry-aapl', null, sized(null)),
      stop('AAPL', 'leg', 'long', sized(100, 90)),
    );
    expect(compareVenue(store(40, [60]), working)).toEqual([]);
    const addOn = stop('AAPL', 'add-on', null, sized(null));
    const withAddOn = view({ AAPL: 40 }, [addOn], aapl([60]));
    const resting = broker(
      40,
      addOn,
      stop('AAPL', 'leg', 'long', sized(40, 60)),
      stop('AAPL', 'add-on-leg', 'long', sized(20, 58)),
    );
    expect(compareVenue(withAddOn, resting)).toEqual([]);
    expect(
      compareVenue(withAddOn, broker(40, stop('AAPL', 'leg', 'long', sized(20, 60)))),
    ).toMatchObject([{ kind: 'protective_qty' }, { kind: 'order_missing_at_broker' }]);
  });

  it('names a bracket stop left at the whole order once a part-filled entry is cancelled', () => {
    expect(
      compareVenue(store(40, [60]), broker(40, stop('AAPL', 'leg', 'long', sized(100, 60)))),
    ).toEqual([
      { kind: 'protective_qty', instrument: 'AAPL', order_id: null, store: 40, broker: 100 },
    ]);
  });

  it('leaves an unguarded or mismatched position to the diffs that already name it', () => {
    expect(compareVenue(store(151, [60]), broker(151)).map((d) => d.kind)).toEqual([
      'position_unprotected',
    ]);
    expect(
      compareVenue(store(151, [60]), broker(150, stop('AAPL', 'leg', 'long', sized(101, 90)))).map(
        (d) => d.kind,
      ),
    ).toEqual(['position_qty']);
  });
});

describe('rearmable (#1990)', () => {
  const guarded = { entryOrderIds: ['entry-AAPL'], stops: [60] };

  it('re-arms only a name with a journalled stop and no entry working at the venue', () => {
    const broker = view({ AAPL: 6 });
    expect(rearmable(view({ AAPL: 6 }, [], { AAPL: guarded }), broker)('AAPL')).toBe(true);
    expect(
      rearmable(view({ AAPL: 6 }, [], { AAPL: { ...guarded, stops: [] } }), broker)('AAPL'),
    ).toBe(false);
    expect(rearmable(view({ AAPL: 6 }), broker)('AAPL')).toBe(false);
    expect(
      rearmable(
        view({ AAPL: 6 }, [], { AAPL: guarded }),
        view({ AAPL: 6 }, [stop('AAPL', 'entry-AAPL', null)]),
      )('AAPL'),
    ).toBe(false);
  });
});
