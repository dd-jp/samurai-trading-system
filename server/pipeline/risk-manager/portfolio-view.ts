/**
 * Portfolio-accounting view (#78) — computes `PortfolioView` from open
 * positions plus current marks from the Market Data Service. See
 * docs/specs/risk-manager-spec.md ("Module: State & Accounting").
 *
 * `cash`, `consecutive_losses` and the session-open basis for daily PnL are
 * taken here as pre-computed inputs rather than invented — they come from the
 * account layer, which owns the broker ledger and the durable snapshots.
 *
 * The daily-PnL *division* does happen here though (#332), and deliberately:
 * its unrealized term is a mark-to-market over open positions, and this
 * function has already fetched every mark it needs for the exposure math. Doing
 * it in the account provider instead would mean a second round of `getMark`
 * calls for the same instruments at the same instant.
 */
import type { MarketDataService } from '../../providers/market-data-service/index.js';
import type { AssetClass, OpenPosition } from '../../shared/index.js';
import type { DailyPnl, PortfolioView, SessionBasis, SessionBasisByClass } from './types.js';

export interface PortfolioAccountingInput {
  positions: OpenPosition[];
  marketData: MarketDataService;
  /** Point-in-time read for every mark lookup — never wall-clock. */
  asOf: Date;
  cash: number;
  peak_equity: number;
  /**
   * Per-class session-open equity and realized PnL since that open (#332).
   * The unrealized half is added here, from the marks fetched below.
   */
  daily_basis: SessionBasisByClass;
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

/**
 * Unrealized PnL on one lot: `(mark − avg_entry_price) × filled_size`,
 * side-signed so a short gains when the mark falls.
 *
 * `filled_size` not `requested_size` (cross-spec §4) — an unfilled lot carries
 * no PnL, and `avg_entry_price` is 0 until the first fill lands, which is why
 * the two fields must be read together.
 */
function unrealizedFor(position: OpenPosition, mark: number): number {
  const direction = position.side === 'buy' ? 1 : -1;
  return (mark - position.avg_entry_price) * position.filled_size * direction;
}

/**
 * Completes one class's daily PnL: `(realized + unrealized) / open_equity`.
 *
 * An unknown basis stays unknown — there is no arithmetic that recovers a
 * denominator nobody recorded, and the union's whole purpose is that this
 * cannot silently become `0`.
 *
 * The unrealized term is each open lot's *lifetime* gain, not its gain since
 * the session boundary: a mark at the boundary is not stored, so a position
 * held across the open contributes PnL it earned yesterday. #332 specifies this
 * figure explicitly and it is the conservative direction for a loss breaker (a
 * losing held position reads at least as bad as it truly is today), but it is
 * an approximation, not an identity — which is a further reason the three
 * per-class figures are not expected to reconcile against one another.
 */
function dailyPnlFor(basis: SessionBasis, unrealized: number): DailyPnl {
  if (!basis.known) {
    return { known: false, reason: basis.reason };
  }

  return { known: true, pct: (basis.realized_pnl + unrealized) / basis.open_equity };
}

export async function computePortfolioView(
  input: PortfolioAccountingInput,
): Promise<PortfolioView> {
  const { positions, marketData, asOf, cash, peak_equity, daily_basis, consecutive_losses } = input;

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
  // Same single pass as the exposure math, over the same `marks` map — #332
  // requires the marks be fetched once, and this is what makes that true.
  const unrealized_by_class: Record<AssetClass, number> = { crypto: 0, stocks: 0 };

  for (const position of positions) {
    // Freeze §4: always filled_size, never requested_size — a partially-filled
    // lot is marked at what actually filled.
    const mark = markFor(marks, position.instrument);
    const notional = position.filled_size * mark;
    exposure_by_instrument[position.instrument] =
      (exposure_by_instrument[position.instrument] ?? 0) + notional;
    exposure_by_class[position.asset_class] += notional;
    unrealized_by_class[position.asset_class] += unrealizedFor(position, mark);
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
    daily_pnl: {
      crypto: dailyPnlFor(daily_basis.crypto, unrealized_by_class.crypto),
      stocks: dailyPnlFor(daily_basis.stocks, unrealized_by_class.stocks),
      portfolio: dailyPnlFor(
        daily_basis.portfolio,
        unrealized_by_class.crypto + unrealized_by_class.stocks,
      ),
    },
    consecutive_losses,
  };
}
