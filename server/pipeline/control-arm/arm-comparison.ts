import type { ClosedTrade, TradingArm } from '../../shared/index.js';

export interface ArmPerformance {
  arm: TradingArm;
  trade_count: number;
  realized_pnl_net: number;
  return_pct: number;
  max_drawdown_pct: number;
  refused_pass_count: number;
  cost_basis_drops: ExitClassDropCounts;
}

export const EXIT_CLASSES = ['protective', 'flatten'] as const;

export type ExitClass = (typeof EXIT_CLASSES)[number];

export interface CostBasisDropCount {
  kept: number;
  dropped: number;
}

export type ExitClassDropCounts = Readonly<Record<ExitClass, CostBasisDropCount>>;

export type ArmCostBasisDrops = Readonly<Record<TradingArm, ExitClassDropCounts>>;

export function exitClassOf(close_reason: ClosedTrade['close_reason']): ExitClass {
  switch (close_reason) {
    case 'stop':
    case 'target':
      return 'protective';
    case 'exit':
    case 'flatten':
    case 'signal_decay':
    case 'direction_flip':
      return 'flatten';
    default: {
      const unhandled: never = close_reason;
      throw new Error(
        `exitClassOf: unhandled close_reason ${JSON.stringify(unhandled)} — a new value must be ` +
          'classified as protective (priced by the entry capture) or flatten (priced by its own), ' +
          'because #1546 counts the cost-basis exclusion along exactly that split.',
      );
    }
  }
}

export function noCostBasisDrops(): ExitClassDropCounts {
  return { protective: { kept: 0, dropped: 0 }, flatten: { kept: 0, dropped: 0 } };
}

export type ArmRefusedPassCounts = Readonly<Record<TradingArm, number>>;

export interface ArmComparison {
  from: Date;
  to: Date;
  basis: number;
  live: ArmPerformance;
  control: ArmPerformance;
}

export function buildArmComparison(input: {
  trades: readonly (ClosedTrade & { arm?: TradingArm })[];
  refused_passes: ArmRefusedPassCounts;
  cost_basis_drops: ArmCostBasisDrops;
  from: Date;
  to: Date;
  basis: number;
}): ArmComparison {
  if (!(input.basis > 0) || !Number.isFinite(input.basis)) {
    throw new Error(
      `buildArmComparison: basis must be a positive, finite number, but it is ` +
        `${String(input.basis)}. Both arms' percentages are taken against it, so an ` +
        'unusable basis would produce a comparison that reads as a measurement.',
    );
  }

  const inWindow = input.trades.filter(
    (trade) =>
      trade.closed_at.getTime() > input.from.getTime() &&
      trade.closed_at.getTime() <= input.to.getTime(),
  );

  return {
    from: input.from,
    to: input.to,
    basis: input.basis,
    live: performanceFor(
      'live',
      inWindow,
      input.basis,
      input.refused_passes.live,
      input.cost_basis_drops.live,
    ),
    control: performanceFor(
      'control',
      inWindow,
      input.basis,
      input.refused_passes.control,
      input.cost_basis_drops.control,
    ),
  };
}

export interface CumulativePnl {
  net: number;
  return_pct: number;
  max_drawdown_pct: number;
}

export function cumulativePnl(trades: readonly ClosedTrade[], basis: number): CumulativePnl {
  const sorted = [...trades].sort(
    (a, b) =>
      a.closed_at.getTime() - b.closed_at.getTime() ||
      a.idempotency_key.localeCompare(b.idempotency_key),
  );

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of sorted) {
    cumulative += trade.realized_pnl_net;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return { net: cumulative, return_pct: cumulative / basis, max_drawdown_pct: maxDrawdown / basis };
}

function performanceFor(
  arm: TradingArm,
  trades: readonly (ClosedTrade & { arm?: TradingArm })[],
  basis: number,
  refusedPassCount: number,
  costBasisDrops: ExitClassDropCounts,
): ArmPerformance {
  const mine = trades.filter((trade) => (trade.arm ?? 'live') === arm);
  const { net, return_pct, max_drawdown_pct } = cumulativePnl(mine, basis);

  return {
    arm,
    trade_count: mine.length,
    realized_pnl_net: net,
    return_pct,
    max_drawdown_pct,
    refused_pass_count: refusedPassCount,
    cost_basis_drops: costBasisDrops,
  };
}
