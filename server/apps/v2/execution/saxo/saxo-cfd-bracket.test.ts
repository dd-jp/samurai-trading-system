import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SaxoBrokerProviderError } from './saxo-broker-errors.js';
import {
  CfdBracketError,
  type CfdBracketOrderIds,
  type CfdShortBracket,
  cfdShortBracketRequest,
  cfdWireReference,
  settleCfdShortBracket,
  submitCfdShortBracket,
} from './saxo-cfd-bracket.js';
import type {
  SaxoOpenApiClient,
  SaxoOpenOrder,
  SaxoOrderActivity,
  SaxoOrderPlacement,
  SaxoOrderRequest,
} from './saxo-client.js';

const BRACKET: CfdShortBracket = {
  clientOrderId: 'debate-2026-10-05-AAPL-short',
  uic: 211,
  assetType: 'CfdOnStock',
  amount: 10,
  entry: 200,
  stop: 210,
  target: 180,
};

const REF = cfdWireReference(BRACKET.clientOrderId);
const IDS: CfdBracketOrderIds = { entry: 'E1', stop: 'S1', target: 'T1' };
const SINCE = new Date('2026-10-05T13:00:00Z');

interface FakeClient extends SaxoOpenApiClient {
  readonly placed: { request: SaxoOrderRequest; requestId: string }[];
  readonly cancelled: string[];
  readonly activitiesFrom: Date[];
}

function fakeClient(
  options: {
    placement?: SaxoOrderPlacement;
    activities?: SaxoOrderActivity[];
    open?: SaxoOpenOrder[];
    cancelError?: unknown;
  } = {},
): FakeClient {
  const placed: FakeClient['placed'] = [];
  const cancelled: string[] = [];
  const activitiesFrom: Date[] = [];
  const unused = () => Promise.reject(new Error('not used by the bracket'));
  return {
    placed,
    cancelled,
    activitiesFrom,
    getInstrumentDetails: unused,
    getInfoPrice: unused,
    listNetPositions: unused,
    placeOrder: async (request, requestId) => {
      placed.push({ request, requestId });
      return options.placement ?? { OrderId: 'E1' };
    },
    cancelOrder: async (orderId) => {
      if (options.cancelError !== undefined) throw options.cancelError;
      cancelled.push(orderId);
    },
    listOpenOrders: async () => options.open ?? [],
    listOrderActivities: async (from) => {
      activitiesFrom.push(from);
      return options.activities ?? [];
    },
  };
}

function activity(OrderId: string, Status: string): SaxoOrderActivity {
  return {
    ActivityTime: '2026-10-05T14:00:00Z',
    LogId: `${OrderId}-${Status}`,
    OrderId,
    Status,
    Amount: 10,
    BuySell: 'Buy',
    Uic: 211,
    AssetType: 'CfdOnStock',
  };
}

function openOrder(OrderId: string, related: string[] = []): SaxoOpenOrder {
  return {
    OrderId,
    Status: 'Working',
    OpenOrderType: 'Limit',
    Amount: 10,
    BuySell: 'Buy',
    Uic: 211,
    AssetType: 'CfdOnStock',
    ...(related.length === 0
      ? {}
      : {
          RelatedOpenOrders: related.map((id) => ({
            OrderId: id,
            OpenOrderType: 'StopIfTraded',
            Amount: 10,
            Status: 'Working',
          })),
        }),
  };
}

describe('cfdShortBracketRequest (#1916)', () => {
  it('sells at a day limit with a GTC StopIfTraded and a GTC Limit buy as related orders', () => {
    const leg = {
      Amount: 10,
      AssetType: 'CfdOnStock',
      Uic: 211,
      BuySell: 'Buy',
      ManualOrder: false,
    };
    expect(cfdShortBracketRequest(BRACKET)).toEqual({
      Uic: 211,
      AssetType: 'CfdOnStock',
      BuySell: 'Sell',
      Amount: 10,
      OrderType: 'Limit',
      OrderPrice: 200,
      OrderDuration: { DurationType: 'DayOrder' },
      ManualOrder: false,
      ExternalReference: REF,
      Orders: [
        {
          ...leg,
          OrderType: 'StopIfTraded',
          OrderPrice: 210,
          OrderDuration: { DurationType: 'GoodTillCancel' },
          ExternalReference: `${REF}:stop`,
        },
        {
          ...leg,
          OrderType: 'Limit',
          OrderPrice: 180,
          OrderDuration: { DurationType: 'GoodTillCancel' },
          ExternalReference: `${REF}:target`,
        },
      ],
    });
  });

  it('hashes the client order id into a 40-hex reference whose leg refs fit Saxo', () => {
    expect(REF).toMatch(/^[0-9a-f]{40}$/);
    expect(cfdWireReference(BRACKET.clientOrderId)).toBe(REF);
    expect(cfdWireReference('other')).not.toBe(REF);
    expect(`${REF}:target`.length).toBeLessThanOrEqual(50);
  });

  it.each([
    ['a fractional amount', { amount: 1.5 }, 'positive whole number'],
    ['a zero amount', { amount: 0 }, 'positive whole number'],
    ['a negative amount', { amount: -1 }, 'positive whole number'],
    ['a target above entry', { target: 201 }, '0 < target < entry'],
    ['a target at entry', { target: 200 }, '0 < target < entry'],
    ['a zero target', { target: 0 }, '0 < target < entry'],
    ['a non-finite stop', { stop: Number.POSITIVE_INFINITY }, '0 < target < entry'],
    ['a NaN entry', { entry: Number.NaN }, '0 < target < entry'],
    ['a stop below entry', { stop: 199 }, 'entry < stop'],
    ['a stop at entry', { stop: 200 }, 'entry < stop'],
  ])('refuses %s', (_label, change, message) => {
    expect(() => cfdShortBracketRequest({ ...BRACKET, ...change })).toThrow(CfdBracketError);
    expect(() => cfdShortBracketRequest({ ...BRACKET, ...change })).toThrow(
      `${BRACKET.clientOrderId}: `,
    );
    expect(() => cfdShortBracketRequest({ ...BRACKET, ...change })).toThrow(message);
    expect(() => cfdShortBracketRequest({ ...BRACKET, ...change })).toThrow(
      expect.objectContaining({ name: 'CfdBracketError' }),
    );
  });
});

describe('submitCfdShortBracket (#1916)', () => {
  it('places once with the reference as request id and returns the three order ids', async () => {
    const client = fakeClient({
      placement: {
        OrderId: 'E1',
        Orders: [
          { OrderId: 'T1', ExternalReference: `${REF}:target` },
          { OrderId: 'S1', ExternalReference: `${REF}:stop` },
        ],
      },
    });
    await expect(submitCfdShortBracket(client, BRACKET)).resolves.toEqual(IDS);
    expect(client.placed).toHaveLength(1);
    expect(client.placed[0]?.requestId).toBe(REF);
    expect(client.placed[0]?.request).toEqual(cfdShortBracketRequest(BRACKET));
    expect(client.cancelled).toEqual([]);
  });

  it.each([
    ['no related orders', undefined],
    ['only the stop', [{ OrderId: 'S1', ExternalReference: `${REF}:stop` }]],
    ['only the target', [{ OrderId: 'T1', ExternalReference: `${REF}:target` }]],
    ['legs under a foreign reference', [{ OrderId: 'S1', ExternalReference: 'x:stop' }]],
  ])('cancels the entry and throws when Saxo returns %s', async (_label, Orders) => {
    const client = fakeClient({ placement: { OrderId: 'E1', Orders } });
    const outcome = submitCfdShortBracket(client, BRACKET);
    await expect(outcome).rejects.toThrow(CfdBracketError);
    await expect(outcome).rejects.toThrow(
      `${BRACKET.clientOrderId}: Saxo placed the entry without both exit legs; the entry was cancelled`,
    );
    expect(client.cancelled).toEqual(['E1']);
  });

  it('places nothing for an invalid bracket', async () => {
    const client = fakeClient();
    await expect(submitCfdShortBracket(client, { ...BRACKET, stop: 190 })).rejects.toThrow(
      CfdBracketError,
    );
    expect(client.placed).toEqual([]);
  });
});

describe('settleCfdShortBracket (#1916)', () => {
  it('leaves both legs resting when neither has a fill, reading activities from since', async () => {
    const client = fakeClient({
      activities: [activity('S1', 'Placed'), activity('OTHER', 'FinalFill')],
      open: [openOrder('S1'), openOrder('T1')],
    });
    await expect(settleCfdShortBracket(client, IDS, SINCE)).resolves.toEqual({ kind: 'resting' });
    expect(client.activitiesFrom).toEqual([SINCE]);
    expect(client.cancelled).toEqual([]);
  });

  it('cancels the target when the stop fills', async () => {
    const client = fakeClient({
      activities: [activity('S1', 'Fill'), activity('S1', 'FinalFill')],
      open: [openOrder('T1')],
    });
    await expect(settleCfdShortBracket(client, IDS, SINCE)).resolves.toEqual({
      kind: 'closed',
      filled: 'stop',
      siblingCancelled: true,
    });
    expect(client.cancelled).toEqual(['T1']);
  });

  it('cancels the stop when the target fills, finding it among related orders', async () => {
    const client = fakeClient({
      activities: [activity('T1', 'FinalFill')],
      open: [openOrder('X1'), openOrder('E9', ['X2', 'S1'])],
    });
    await expect(settleCfdShortBracket(client, IDS, SINCE)).resolves.toEqual({
      kind: 'closed',
      filled: 'target',
      siblingCancelled: true,
    });
    expect(client.cancelled).toEqual(['S1']);
  });

  it('cancels nothing when the sibling is already off the open list', async () => {
    const client = fakeClient({
      activities: [activity('S1', 'FinalFill')],
      open: [openOrder('OTHER', ['ALSO-OTHER'])],
    });
    await expect(settleCfdShortBracket(client, IDS, SINCE)).resolves.toEqual({
      kind: 'closed',
      filled: 'stop',
      siblingCancelled: false,
    });
    expect(client.cancelled).toEqual([]);
  });

  it('treats a not-found cancel as the sibling already gone', async () => {
    const client = fakeClient({
      activities: [activity('S1', 'FinalFill')],
      open: [openOrder('T1')],
      cancelError: new SaxoBrokerProviderError('gone', 404),
    });
    await expect(settleCfdShortBracket(client, IDS, SINCE)).resolves.toEqual({
      kind: 'closed',
      filled: 'stop',
      siblingCancelled: false,
    });
  });

  it('rethrows any other cancel failure', async () => {
    const failure = new SaxoBrokerProviderError('down', 503);
    const client = fakeClient({
      activities: [activity('T1', 'FinalFill')],
      open: [openOrder('S1')],
      cancelError: failure,
    });
    await expect(settleCfdShortBracket(client, IDS, SINCE)).rejects.toBe(failure);
  });

  it.each([
    [
      'both legs filled',
      [activity('S1', 'FinalFill'), activity('T1', 'FinalFill')],
      'final',
      'final',
    ],
    ['a partial stop', [activity('S1', 'Fill')], 'partial', 'none'],
    ['a partial target', [activity('T1', 'Fill')], 'none', 'partial'],
    [
      'a filled stop and a partial target',
      [activity('S1', 'FinalFill'), activity('T1', 'Fill')],
      'final',
      'partial',
    ],
    [
      'a partial stop and a filled target',
      [activity('S1', 'Fill'), activity('T1', 'FinalFill')],
      'partial',
      'final',
    ],
  ])('reports %s as unresolved and cancels nothing', async (_label, activities, stop, target) => {
    const client = fakeClient({ activities, open: [openOrder('S1'), openOrder('T1')] });
    await expect(settleCfdShortBracket(client, IDS, SINCE)).resolves.toEqual({
      kind: 'unresolved',
      stop,
      target,
    });
    expect(client.cancelled).toEqual([]);
  });
});

describe('CFD bracket reachability (#1916)', () => {
  it('is imported by no production module until a live gate wires it', () => {
    const root = fileURLToPath(new URL('../../../../../', import.meta.url));
    const production = ['server', 'contracts'].flatMap((top) =>
      readdirSync(join(root, top), { recursive: true, encoding: 'utf8' })
        .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
        .map((path) => join(top, path)),
    );
    expect(production).toContain(join('server', 'apps', 'v2', 'execution', 'executor.ts'));
    const importers = production.filter((path) =>
      readFileSync(join(root, path), 'utf8').includes('saxo-cfd-bracket'),
    );
    expect(importers).toEqual([]);
  });
});
