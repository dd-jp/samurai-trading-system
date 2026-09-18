import type { Fill, OpenPosition } from './types.js';

export type ExitFill = Fill & { leg: 'stop' | 'target' | 'exit' };

export function isExitFill(fill: Fill): fill is ExitFill {
  return fill.leg !== 'entry';
}

export function totalQty(fills: readonly Fill[]): number {
  return fills.reduce((sum, fill) => sum + fill.qty, 0);
}

export function weightedAvgPrice(fills: readonly Fill[]): number {
  const qty = totalQty(fills);
  if (qty === 0) return 0;
  return fills.reduce((sum, fill) => sum + fill.price * fill.qty, 0) / qty;
}

export interface LotHeldQuantity {
  idempotency_key: string;
  held: number;
}

export async function heldQuantitiesFor(
  lots: readonly OpenPosition[],
  reader: (idempotency_keys: readonly string[]) => Promise<Map<string, number>>,
): Promise<LotHeldQuantity[]> {
  const exitFillSizes = await reader(lots.map((lot) => lot.idempotency_key));
  return lots.map((lot) => ({
    idempotency_key: lot.idempotency_key,
    held: lot.filled_size - (exitFillSizes.get(lot.idempotency_key) ?? 0),
  }));
}

export function totalHeldQuantity(held: readonly LotHeldQuantity[]): number {
  return held.reduce((sum, lot) => sum + lot.held, 0);
}

export const QTY_EPSILON_RELATIVE = 1e-12;

export function coversQty(actual: number, target: number): boolean {
  return actual >= target - Math.abs(target) * QTY_EPSILON_RELATIVE;
}

export interface RecordedHeldQuantity {
  filledSize: number;
  exitQty: number;
  held: number;
}

export function heldQuantityFromFills(fills: readonly Fill[]): RecordedHeldQuantity {
  const filledSize = totalQty(fills.filter((fill) => fill.leg === 'entry'));
  const exitQty = totalQty(fills.filter(isExitFill));
  return { filledSize, exitQty, held: filledSize - exitQty };
}

export function isFlat(recorded: Pick<RecordedHeldQuantity, 'filledSize' | 'exitQty'>): boolean {
  return coversQty(recorded.exitQty, recorded.filledSize);
}
