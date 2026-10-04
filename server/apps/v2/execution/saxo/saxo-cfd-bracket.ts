import { createHash } from 'node:crypto';
import { isOrderNotFound } from './saxo-broker-errors.js';
import type {
  SaxoCfdAssetType,
  SaxoOpenApiClient,
  SaxoOpenOrder,
  SaxoOrderActivity,
  SaxoOrderPlacement,
  SaxoOrderRequest,
} from './saxo-client.js';

// Saxo caps ExternalReference at 50 characters: 40 hex plus ':target' leaves room
const REFERENCE_HEX_CHARS = 40;

type CfdLeg = 'stop' | 'target';

type LegFill = 'none' | 'partial' | 'final';

export interface CfdShortBracket {
  readonly clientOrderId: string;
  readonly uic: number;
  readonly assetType: SaxoCfdAssetType;
  readonly amount: number;
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
}

export interface CfdBracketOrderIds {
  readonly entry: string;
  readonly stop: string;
  readonly target: string;
}

export type CfdBracketSettlement =
  | { readonly kind: 'resting' }
  | { readonly kind: 'closed'; readonly filled: CfdLeg; readonly siblingCancelled: boolean }
  | { readonly kind: 'unresolved'; readonly stop: LegFill; readonly target: LegFill };

export class CfdBracketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CfdBracketError';
  }
}

export function cfdWireReference(clientOrderId: string): string {
  return createHash('sha256').update(clientOrderId).digest('hex').slice(0, REFERENCE_HEX_CHARS);
}

function isPositivePrice(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

function assertShortBracket(bracket: CfdShortBracket): void {
  if (!Number.isInteger(bracket.amount) || bracket.amount <= 0) {
    throw new CfdBracketError(`${bracket.clientOrderId}: amount must be a positive whole number`);
  }
  const prices = [bracket.target, bracket.entry, bracket.stop];
  if (!prices.every(isPositivePrice) || !(bracket.target < bracket.entry)) {
    throw new CfdBracketError(`${bracket.clientOrderId}: a short needs 0 < target < entry`);
  }
  if (!(bracket.entry < bracket.stop)) {
    throw new CfdBracketError(`${bracket.clientOrderId}: a short needs entry < stop`);
  }
}

// IsOcoOrderSupported is false on Saxo CFDs: the two exits rest as plain related orders and
// settleCfdShortBracket cancels the survivor. Never verified against Saxo (#1916).
export function cfdShortBracketRequest(bracket: CfdShortBracket): SaxoOrderRequest {
  assertShortBracket(bracket);
  const reference = cfdWireReference(bracket.clientOrderId);
  const leg = (OrderType: 'StopIfTraded' | 'Limit', OrderPrice: number, suffix: CfdLeg) => ({
    OrderType,
    OrderPrice,
    BuySell: 'Buy' as const,
    Amount: bracket.amount,
    AssetType: bracket.assetType,
    Uic: bracket.uic,
    OrderDuration: { DurationType: 'GoodTillCancel' as const },
    ManualOrder: false as const,
    ExternalReference: `${reference}:${suffix}`,
  });
  return {
    Uic: bracket.uic,
    AssetType: bracket.assetType,
    BuySell: 'Sell',
    Amount: bracket.amount,
    OrderType: 'Limit',
    OrderPrice: bracket.entry,
    OrderDuration: { DurationType: 'DayOrder' },
    ManualOrder: false,
    ExternalReference: reference,
    Orders: [leg('StopIfTraded', bracket.stop, 'stop'), leg('Limit', bracket.target, 'target')],
  };
}

function legOrderId(
  placement: SaxoOrderPlacement,
  reference: string,
  suffix: CfdLeg,
): string | undefined {
  return placement.Orders?.find((order) => order.ExternalReference === `${reference}:${suffix}`)
    ?.OrderId;
}

export async function submitCfdShortBracket(
  client: SaxoOpenApiClient,
  bracket: CfdShortBracket,
): Promise<CfdBracketOrderIds> {
  const request = cfdShortBracketRequest(bracket);
  const reference = request.ExternalReference;
  const placement = await client.placeOrder(request, reference);
  const stop = legOrderId(placement, reference, 'stop');
  const target = legOrderId(placement, reference, 'target');
  if (stop !== undefined && target !== undefined) {
    return { entry: placement.OrderId, stop, target };
  }
  await client.cancelOrder(placement.OrderId);
  throw new CfdBracketError(
    `${bracket.clientOrderId}: Saxo placed the entry without both exit legs; the entry was cancelled`,
  );
}

function legFill(activities: readonly SaxoOrderActivity[], orderId: string): LegFill {
  const statuses = activities
    .filter((activity) => activity.OrderId === orderId)
    .map((activity) => activity.Status);
  if (statuses.includes('FinalFill')) return 'final';
  return statuses.includes('Fill') ? 'partial' : 'none';
}

function isOpen(open: readonly SaxoOpenOrder[], orderId: string): boolean {
  return open.some(
    (order) =>
      order.OrderId === orderId ||
      (order.RelatedOpenOrders ?? []).some((related) => related.OrderId === orderId),
  );
}

async function cancelIfOpen(client: SaxoOpenApiClient, orderId: string): Promise<boolean> {
  if (!isOpen(await client.listOpenOrders(), orderId)) return false;
  try {
    await client.cancelOrder(orderId);
    return true;
  } catch (error) {
    if (isOrderNotFound(error)) return false;
    throw error;
  }
}

function settledLeg(stop: LegFill, target: LegFill): CfdLeg | undefined {
  if (stop === 'final' && target === 'none') return 'stop';
  return target === 'final' && stop === 'none' ? 'target' : undefined;
}

// Only one fully filled leg against an unfilled sibling is settled here; any partial fill or
// a double fill is left untouched and reported, since cancelling then could strand cover
export async function settleCfdShortBracket(
  client: SaxoOpenApiClient,
  ids: CfdBracketOrderIds,
  since: Date,
): Promise<CfdBracketSettlement> {
  const activities = await client.listOrderActivities(since);
  const stop = legFill(activities, ids.stop);
  const target = legFill(activities, ids.target);
  if (stop === 'none' && target === 'none') return { kind: 'resting' };
  const filled = settledLeg(stop, target);
  if (filled === undefined) return { kind: 'unresolved', stop, target };
  const sibling = filled === 'stop' ? ids.target : ids.stop;
  return { kind: 'closed', filled, siblingCancelled: await cancelIfOpen(client, sibling) };
}
