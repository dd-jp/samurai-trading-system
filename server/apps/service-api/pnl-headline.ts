/**
 * The Glance P&L headline (#1595, ADR-0021's 2026-09-15 amendment): one arm's
 * all-time P&L with drawdown, and its Europe/London-today P&L, both in GBP.
 *
 * Reuses `cumulativePnlAndDrawdown` (`control-arm/arm-comparison.ts`) — the
 * same derivation the Feedback Loop's rolling-window comparison already uses
 * — rather than re-deriving cumulative realized P&L and drawdown a second
 * way. `buildSnapshot` passes it every closed trade for this arm (unbounded,
 * `getAllClosedTrades`) and this arm's already-computed open unrealized P&L
 * (`positions[].unrealized_pnl`, summed) so this module stays a pure function
 * with no store access of its own.
 *
 * Shares the derivation, NOT the row population, with the FL's
 * `ArmPerformanceWire` figure — `getAllClosedTrades` is every row for the
 * arm, unfiltered by `oneSizingRegime`/`modelledCostCharged`. See
 * `PnlHeadlineWire`'s header (`contracts/snapshot.ts`) for why, and which way
 * the two figures can diverge.
 */
import { cumulativePnlAndDrawdown } from '../../pipeline/control-arm/index.js';
import { LONDON_ZONE, toCivilDate } from '../../providers/market-data-service/index.js';
import type { ClosedTrade } from '../../shared/index.js';
import type { PnlHeadlineWire } from './types.js';

function sameLondonDay(a: Date, b: Date): boolean {
  const civilA = toCivilDate(a, LONDON_ZONE);
  const civilB = toCivilDate(b, LONDON_ZONE);
  return civilA.year === civilB.year && civilA.month === civilB.month && civilA.day === civilB.day;
}

export interface PnlHeadlineInput {
  asOf: Date;
  /** Every closed trade for ONE arm, any order — see `cumulativePnlAndDrawdown`'s own sort. */
  allClosedTrades: readonly ClosedTrade[];
  /** This arm's open positions' unrealized P&L, summed, in USD (the account's currency). */
  openUnrealizedUsd: number;
  /** `SIZING_USD_PER_GBP` (`paper-profile.ts`, #1180) — USD per GBP, display-only. */
  usdPerGbp: number;
  /** `LIVE_BOOK_GBP` (`paper-profile.ts`) — the declared book both percentages are taken against. */
  bookGbp: number;
  conversionSource: string;
}

export function buildPnlHeadline(input: PnlHeadlineInput): PnlHeadlineWire {
  const { asOf, allClosedTrades, openUnrealizedUsd, usdPerGbp, bookGbp, conversionSource } = input;
  const toGbp = (usd: number): number => usd / usdPerGbp;

  const overallSeries = cumulativePnlAndDrawdown(allClosedTrades);
  const overallNetGbp = toGbp(overallSeries.realized_pnl_net + openUnrealizedUsd);
  const overallMaxDrawdownGbp = toGbp(overallSeries.max_drawdown);

  const todayTrades = allClosedTrades.filter((trade) => sameLondonDay(trade.closed_at, asOf));
  const todaySeries = cumulativePnlAndDrawdown(todayTrades);
  const todayRealizedGbp = toGbp(todaySeries.realized_pnl_net);
  const todayUnrealizedGbp = toGbp(openUnrealizedUsd);
  const todayCostsGbp = toGbp(todayTrades.reduce((sum, trade) => sum + trade.fees_total, 0));

  return {
    overall: {
      net_gbp: overallNetGbp,
      pct_of_book: overallNetGbp / bookGbp,
      max_drawdown_pct: overallMaxDrawdownGbp / bookGbp,
      trade_count: overallSeries.trade_count,
    },
    today: {
      net_gbp: todayRealizedGbp + todayUnrealizedGbp,
      pct_of_book: (todayRealizedGbp + todayUnrealizedGbp) / bookGbp,
      realized_gbp: todayRealizedGbp,
      unrealized_gbp: todayUnrealizedGbp,
      costs_gbp: todayCostsGbp,
      trade_count: todaySeries.trade_count,
    },
    conversion: {
      usd_per_gbp: usdPerGbp,
      source: conversionSource,
    },
  };
}
