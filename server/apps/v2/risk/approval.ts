import type {
  ApprovedBracketEntry,
  ApprovedFlatten,
  RiskApprovedOrder,
} from '../../../../contracts/index.js';

const minted = new WeakSet<object>();

export function mintApproval(fields: ApprovedBracketEntry | ApprovedFlatten): RiskApprovedOrder {
  const order = Object.freeze({ ...fields }) as RiskApprovedOrder;
  minted.add(order);
  return order;
}

export function isRiskApproved(order: object): boolean {
  return minted.has(order);
}
