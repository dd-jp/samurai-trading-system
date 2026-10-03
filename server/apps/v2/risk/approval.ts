import type {
  ApprovedBracketEntry,
  ApprovedFlatten,
  ApprovedRearm,
  ApprovedStopReplace,
  RiskApprovedOrder,
} from '../../../../contracts/index.js';

const minted = new WeakSet<object>();

export function mintApproval(
  fields: ApprovedBracketEntry | ApprovedFlatten | ApprovedRearm | ApprovedStopReplace,
): RiskApprovedOrder {
  const order = Object.freeze({ ...fields }) as RiskApprovedOrder;
  minted.add(order);
  return order;
}

export function isRiskApproved(order: object): boolean {
  return minted.has(order);
}

export function consumeApproval(order: object): boolean {
  return minted.delete(order);
}
