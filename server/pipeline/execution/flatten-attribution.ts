import type { BrokerFillId } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import { chargeTopUpTo, prorateCostBreakdown } from './fill-cost.js';
import type { FlattenAttribution, NormalizedFill } from './types.js';

export interface FlattenSplitInput {
  clientOrderId: string;
  rawFills: readonly NormalizedFill[];
  lotKeys: readonly string[];
  totalShare: ReadonlyMap<string, number>;
  attribution: Pick<FlattenAttribution, 'exit_reason' | 'modelled_cost_breakdown' | 'size'>;
}

interface RawFillOutcome {
  rawFill: NormalizedFill;
  attributed: readonly { idempotency_key: string; broker_fill_id: BrokerFillId }[];
  leftover: number;
}

export interface FlattenSplit {
  splits: ReadonlyMap<string, readonly NormalizedFill[]>;
  outcomes: readonly RawFillOutcome[];
  remaining: ReadonlyMap<string, number>;
}

function buildFlattenSplitFill(
  rawFill: NormalizedFill,
  lotKey: string,
  take: number,
  clientOrderId: string,
  attribution: Pick<FlattenAttribution, 'exit_reason' | 'modelled_cost_breakdown' | 'size'>,
): NormalizedFill {
  const share = take / rawFill.qty;
  const flattenCostBreakdown =
    rawFill.cost_breakdown === undefined &&
    attribution.modelled_cost_breakdown !== null &&
    attribution.size > 0
      ? prorateCostBreakdown(attribution.modelled_cost_breakdown, take / attribution.size)
      : undefined;
  return {
    ...rawFill,
    leg: 'exit',
    ...(attribution.exit_reason === null ? {} : { exit_reason: attribution.exit_reason }),
    flatten_idempotency_key: clientOrderId,
    broker_fill_id: toBrokerFillId(`${rawFill.broker_fill_id}:${lotKey}`),
    qty: take,
    fee: chargeTopUpTo(rawFill.fee * share, flattenCostBreakdown?.commission),
    ...(flattenCostBreakdown !== undefined ? { cost_breakdown: flattenCostBreakdown } : {}),
    qty_is_cumulative: false,
  };
}

function allocateRawFillAcrossLots(
  rawFill: NormalizedFill,
  lotKeys: readonly string[],
  remaining: Map<string, number>,
  splits: Map<string, NormalizedFill[]>,
  clientOrderId: string,
  attribution: Pick<FlattenAttribution, 'exit_reason' | 'modelled_cost_breakdown' | 'size'>,
): {
  attributedIdsThisRawFill: { idempotency_key: string; broker_fill_id: BrokerFillId }[];
  leftover: number;
} {
  let leftover = rawFill.qty;
  const attributedIdsThisRawFill: { idempotency_key: string; broker_fill_id: BrokerFillId }[] = [];
  for (const lotKey of lotKeys) {
    if (leftover <= 0) break;
    const need = remaining.get(lotKey) ?? 0;
    if (need <= 0) continue;

    const take = Math.min(need, leftover);
    const splitFill = buildFlattenSplitFill(rawFill, lotKey, take, clientOrderId, attribution);

    const bucket = splits.get(lotKey);
    if (bucket === undefined) splits.set(lotKey, [splitFill]);
    else bucket.push(splitFill);

    attributedIdsThisRawFill.push({
      idempotency_key: lotKey,
      broker_fill_id: splitFill.broker_fill_id,
    });
    remaining.set(lotKey, need - take);
    leftover -= take;
  }
  return { attributedIdsThisRawFill, leftover };
}

export function splitFlattenFills(input: FlattenSplitInput): FlattenSplit {
  const { clientOrderId, rawFills, lotKeys, totalShare, attribution } = input;
  const splits = new Map<string, NormalizedFill[]>();
  const outcomes: RawFillOutcome[] = [];
  const remaining = new Map(totalShare);
  for (const rawFill of rawFills) {
    const { attributedIdsThisRawFill, leftover } = allocateRawFillAcrossLots(
      rawFill,
      lotKeys,
      remaining,
      splits,
      clientOrderId,
      attribution,
    );
    outcomes.push({ rawFill, attributed: attributedIdsThisRawFill, leftover });
  }

  return { splits, outcomes, remaining };
}
