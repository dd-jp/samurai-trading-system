/**
 * Portfolio-accounting view (#78) — computes `PortfolioView` from open
 * positions plus current marks from the Market Data Service. See
 * docs/specs/risk-manager-spec.md ("Module: State & Accounting").
 *
 * `ClosedTrade`/`Fill` (#83) don't exist in src/ yet, so the realized-PnL
 * derived fields (`daily_pnl_pct`, `consecutive_losses`) and `cash` have no
 * in-repo data source today; they are taken here as pre-computed scalars
 * rather than invented. Only the mark-to-market/exposure math — this
 * ticket's acceptance criteria — is actually computed.
 */
import type { MarketDataService } from '../market-data-service/index.js';
import type { OpenPosition } from '../shared/index.js';
import type { PortfolioView } from './types.js';

export interface PortfolioAccountingInput {
  positions: OpenPosition[];
  marketData: MarketDataService;
  /** Point-in-time read for every mark lookup — never wall-clock. */
  asOf: Date;
  cash: number;
  peak_equity: number;
  /** Realized, from fills — not computed here (#83). */
  daily_pnl_pct: number;
  /** Realized, from fills — not computed here (#83). */
  consecutive_losses: number;
}

/**
 * Fails closed on a missing mark instead of defaulting to zero.
 *
 * Unreachable today — `marks` is built from exactly the instruments held, and
 * `MarketDataService.getMark` either answers or throws, so the `Promise.all`
 * above has already rejected if any lookup failed. The guard is here for the
 * day that stops being true (an instrument-key normalization mismatch between
 * the store and the data service is the obvious way in): a zero mark silently
 * reports a real position as zero exposure, which understates gross exposure
 * and drawdown and hands Risk a green light for a trade it would otherwise
 * block. For a view whose entire job is bounding risk, "I don't know" must
 * stop the sweep, not read as "nothing there".
 */
function markFor(marks: Map<string, number>, instrument: string): number {
  const mark = marks.get(instrument);
  if (mark === undefined) {
    throw new Error(
      `computePortfolioView: no mark for held instrument '${instrument}' — refusing to value ` +
        'the position at zero, which would understate exposure to Risk.',
    );
  }
  return mark;
}

export async function computePortfolioView(
  input: PortfolioAccountingInput,
): Promise<PortfolioView> {
  const { positions, marketData, asOf, cash, peak_equity, daily_pnl_pct, consecutive_losses } =
    input;

  const instruments = [...new Set(positions.map((position) => position.instrument))];
  const marks = new Map<string, number>(
    await Promise.all(
      instruments.map(async (instrument) => {
        const mark = await marketData.getMark(instrument, asOf);
        return [instrument, mark.price] as const;
      }),
    ),
  );

  const exposure_by_instrument: Record<string, number> = {};
  const exposure_by_class = { crypto: 0, stocks: 0 };

  for (const position of positions) {
    // Freeze §4: always filled_size, never requested_size — a partially-filled
    // lot is marked at what actually filled.
    const notional = position.filled_size * markFor(marks, position.instrument);
    exposure_by_instrument[position.instrument] =
      (exposure_by_instrument[position.instrument] ?? 0) + notional;
    exposure_by_class[position.asset_class] += notional;
  }

  const gross_exposure = exposure_by_class.crypto + exposure_by_class.stocks;
  const equity = cash + gross_exposure;
  const drawdown_pct = peak_equity > 0 ? Math.max(0, (peak_equity - equity) / peak_equity) : 0;

  return {
    equity,
    peak_equity,
    drawdown_pct,
    exposure_by_instrument,
    exposure_by_class,
    gross_exposure,
    daily_pnl_pct,
    consecutive_losses,
  };
}
