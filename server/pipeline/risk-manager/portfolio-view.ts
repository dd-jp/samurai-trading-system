import {
  classifyMarkFreshness,
  type MarketDataService,
  type MarkFreshness,
} from '../../providers/market-data-service/index.js';
import {
  type AssetClass,
  type Clock,
  describeThrown,
  type OpenPosition,
} from '../../shared/index.js';
import { IN_FLIGHT_ORDER_STATES, isWedgedZeroFillLot } from '../../shared/store/index.js';
import type { DailyPnl, PortfolioView, SessionBasis, SessionBasisByClass } from './types.js';

export interface PortfolioAccountingInput {
  positions: OpenPosition[];
  marketData: MarketDataService;
  asOf: Date;
  clock: Clock;
  cash: number;
  peak_equity: number;
  daily_basis: SessionBasisByClass;
  consecutive_losses: number;
  max_mark_age: Record<AssetClass, number>;
  unvaluable_marks?: UnvaluableMarkPolicy;
}

type UnvaluableMarkPolicy = 'refuse' | 'exclude';

export abstract class BookValuationError extends Error {}

export class MarkReadError extends BookValuationError {
  constructor(
    readonly instrument: string,
    message: string,
    options?: { cause: unknown },
  ) {
    super(message, options);
    this.name = 'MarkReadError';
  }
}

export class StaleMarkError extends BookValuationError {
  constructor(
    readonly instrument: string,
    readonly observed_at: Date,
    readonly readAt: Date,
    readonly asOf: Date,
    readonly freshness: Exclude<MarkFreshness, { status: 'fresh' }>,
  ) {
    const passMs = readAt.getTime() - asOf.getTime();
    const detail =
      freshness.status === 'stale'
        ? `${freshness.age_ms}ms old when read at ${readAt.toISOString()}, past the ` +
          `${freshness.bound_ms}ms bound for its asset class`
        : `stamped ${-freshness.age_ms}ms AHEAD of ${readAt.toISOString()}, the instant we ` +
          `received it — beyond the ${freshness.tolerance_ms}ms receipt tolerance, so our ` +
          "clock and the venue's disagree";
    super(
      `computePortfolioView: mark for held instrument '${instrument}' was observed ` +
        `${observed_at.toISOString()}, ${detail} (this pass read it ${passMs}ms after its ` +
        `asOf ${asOf.toISOString()}). Refusing to value the book on a price the market may no ` +
        'longer support: exposure, drawdown and daily PnL all derive from these marks, so a ' +
        'frozen price freezes every risk limit that reads them.',
    );
    this.name = 'StaleMarkError';
  }
}

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

export function unrealizedFor(position: OpenPosition, mark: number): number {
  const direction = position.side === 'buy' ? 1 : -1;
  return (mark - position.avg_entry_price) * position.filled_size * direction;
}

const RESERVABLE_ORDER_STATES: ReadonlySet<OpenPosition['order_state']> = new Set(
  IN_FLIGHT_ORDER_STATES,
);

function reservedNotional(position: OpenPosition, mark: number): number {
  if (!RESERVABLE_ORDER_STATES.has(position.order_state) && !isWedgedZeroFillLot(position)) {
    return 0;
  }
  return Math.max(position.requested_size - position.filled_size, 0) * mark;
}

function dailyPnlFor(basis: SessionBasis, unrealized: number): DailyPnl {
  if (!basis.known) {
    return { known: false, reason: basis.reason };
  }

  return { known: true, pct: (basis.realized_pnl + unrealized) / basis.open_equity };
}

async function readMarks(
  marketData: MarketDataService,
  classByInstrument: ReadonlyMap<string, AssetClass>,
  asOf: Date,
  clock: Clock,
  max_mark_age: Record<AssetClass, number>,
  policy: UnvaluableMarkPolicy,
): Promise<{ marks: Map<string, number>; unvalued: readonly string[] }> {
  const instruments = [...classByInstrument.keys()];
  const reads = await marketData.getMarks(instruments, asOf);
  const readAt = clock.now();

  const marks = new Map<string, number>();
  const failures: BookValuationError[] = [];

  for (const instrument of instruments) {
    const read = reads.get(instrument);
    if (read === undefined) {
      failures.push(
        new MarkReadError(
          instrument,
          `computePortfolioView: the batch mark read returned no entry for held instrument ` +
            `'${instrument}'.`,
        ),
      );
      continue;
    }
    if (!read.ok) {
      failures.push(
        new MarkReadError(
          instrument,
          `computePortfolioView: the mark read for held instrument '${instrument}' failed, so ` +
            `the book cannot be valued: ${describeThrown(read.error)}`,
          { cause: read.error },
        ),
      );
      continue;
    }

    const assetClass = classByInstrument.get(instrument) ?? read.mark.asset_class;
    const freshness = classifyMarkFreshness(read.mark, readAt, max_mark_age[assetClass]);
    if (freshness.status !== 'fresh') {
      failures.push(new StaleMarkError(instrument, read.mark.observed_at, readAt, asOf, freshness));
      continue;
    }

    marks.set(instrument, read.mark.price);
  }

  const unvalued = [...classByInstrument.keys()].filter((instrument) => !marks.has(instrument));

  if (policy === 'exclude') {
    return { marks, unvalued };
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    const named = unvalued.map((instrument) => `'${instrument}'`).join(', ');
    const reasons = failures.map((failure) => failure.message).join('; ');
    throw new AggregateError(
      failures,
      `computePortfolioView: ${failures.length} held instrument(s) could not be valued at ` +
        `${asOf.toISOString()} — ${named}. Refusing to produce a partial view: every consumer of ` +
        'exposure_by_instrument reads an absent instrument as zero exposure, so a book valued ' +
        'without these would widen the per-asset, per-subclass and gross caps that size real ' +
        `orders. Reasons: ${reasons}`,
      { cause: failures[0] },
    );
  }

  return { marks, unvalued };
}

export async function computePortfolioView(
  input: PortfolioAccountingInput,
): Promise<PortfolioView> {
  const {
    positions,
    marketData,
    asOf,
    cash,
    peak_equity,
    daily_basis,
    consecutive_losses,
    clock,
    max_mark_age,
    unvaluable_marks = 'refuse',
  } = input;

  const classByInstrument = new Map<string, AssetClass>(
    positions.map((position) => [position.instrument, position.asset_class]),
  );

  const { marks, unvalued } = await readMarks(
    marketData,
    classByInstrument,
    asOf,
    clock,
    max_mark_age,
    unvaluable_marks,
  );

  const exposure_by_instrument: Record<string, number> = {};
  const exposure_by_class = { crypto: 0, stocks: 0 };
  const reserved_exposure_by_instrument: Record<string, number> = {};
  const reserved_exposure_by_class = { crypto: 0, stocks: 0 };
  const unrealized_by_class: Record<AssetClass, number> = { crypto: 0, stocks: 0 };

  for (const position of positions) {
    if (unvalued.includes(position.instrument)) continue;
    const mark = markFor(marks, position.instrument);
    const notional = position.filled_size * mark;
    exposure_by_instrument[position.instrument] =
      (exposure_by_instrument[position.instrument] ?? 0) + notional;
    exposure_by_class[position.asset_class] += notional;
    unrealized_by_class[position.asset_class] += unrealizedFor(position, mark);

    const reserved = reservedNotional(position, mark);
    if (reserved > 0) {
      reserved_exposure_by_instrument[position.instrument] =
        (reserved_exposure_by_instrument[position.instrument] ?? 0) + reserved;
      reserved_exposure_by_class[position.asset_class] += reserved;
    }
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
    reserved_exposure_by_instrument,
    reserved_exposure_by_class,
    reserved_gross_exposure: reserved_exposure_by_class.crypto + reserved_exposure_by_class.stocks,
    daily_pnl: {
      crypto: dailyPnlFor(daily_basis.crypto, unrealized_by_class.crypto),
      stocks: dailyPnlFor(daily_basis.stocks, unrealized_by_class.stocks),
      portfolio: dailyPnlFor(
        daily_basis.portfolio,
        unrealized_by_class.crypto + unrealized_by_class.stocks,
      ),
    },
    consecutive_losses,
    unvalued_instruments: unvalued,
  };
}
