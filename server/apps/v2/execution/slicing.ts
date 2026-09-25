import type { RiskApprovedOrder } from '../../../../contracts/index.js';

export interface ChildOrder {
  readonly clientOrderId: string;
  readonly size: number;
}

export function childOrders(order: RiskApprovedOrder): readonly ChildOrder[] {
  return [{ clientOrderId: order.clientOrderId, size: order.size }];
}
