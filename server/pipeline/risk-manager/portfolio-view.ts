/**
 * Portfolio-accounting view — computes `PortfolioView` from open positions
 * plus current marks. See docs/specs/risk-manager-spec.md ("Module: State &
 * Accounting"). `cash`/`consecutive_losses`/daily-PnL basis are pre-computed
 * inputs from the account layer; the daily-PnL division happens here instead
 * since this function already has every mark the exposure math needs, and
 * doing it upstream would mean fetching marks twice.
 */
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
  /** Point-in-time read for every mark lookup — never wall-clock */
  asOf: Date;
  /**
   * The instant marks came back — when this view VALUES the book, and what
   * feed freshness is judged against. Required, not defaulted to `asOf`: a
   * caller that skips it measures freshness from tick-start again, a gap
   * once measured at 145s against a 5000ms tolerance. Injected rather than
   * `Date.now()` so backtest stays deterministic — the replay clock is `asOf`
   * there, making this inert in replay.
   */
  clock: Clock;
  cash: number;
  peak_equity: number;
  /**
   * Per-class session-open equity and realized PnL since that open.
   * The unrealized half is added here, from the marks fetched below.
   */
  daily_basis: SessionBasisByClass;
  /** Realized, from fills — not computed here */
  consecutive_losses: number;
  /**
   * FEED staleness bound per asset class: max `asOf - Mark.observed_at` for a
   * mark used to value a held position. Required, not defaulted — every
   * exposure/drawdown/daily-loss breaker reads this, so a default would be a
   * risk limit chosen by omission. Its own field rather than shared with
   * `VerdictConfig.max_mark_age` (`mark-freshness.ts`): valuing the whole
   * book is a heavier action than declining one trade, and may need a
   * different bound.
   */
  max_mark_age: Record<AssetClass, number>;
  /**
   * What to do with a held instrument whose mark cannot be read or is stale.
   * `'refuse'` (default) throws, producing no view — the ENTRY path's
   * posture, since every cap reads an absent instrument as zero exposure.
   * `'exclude'` values the rest and names the gaps in `unvalued_instruments`
   * — the EXIT path's posture, since refusing there would suppress the
   * flatten of every other name and leave leveraged ETPs (ADR-0016) open
   * overnight against ADR-0014's flat-by-close invariant. Defaults to the
   * conservative `'refuse'` so a forgetful caller still gets full refusal.
   */
  unvaluable_marks?: UnvaluableMarkPolicy;
}

/** See `PortfolioAccountingInput.unvaluable_marks` */
type UnvaluableMarkPolicy = 'refuse' | 'exclude';

/**
 * Base for every reason `computePortfolioView` refuses to value a held
 * instrument — lets a caller catch "the book could not be valued" by type
 * rather than matching on message text (docs/coding-standards.md, "Typed
 * errors only where a caller branches"). `decide.ts`'s `buildBracket` narrows
 * on this (including through an `AggregateError` wrapper, since that's a JS
 * built-in any thunk can reject with) to convert a valuation refusal into a
 * named control-arm skip while letting other rejections propagate.
 */
export abstract class BookValuationError extends Error {}

/**
 * Thrown when a held instrument's mark could not be obtained at all (omitted
 * from the batch, or the lookup itself failed). Distinct from
 * `StaleMarkError` — "no price" vs "a price we no longer trust". The message
 * always repeats the reason, since `describeThrown` (safe-log.ts) prints
 * only `error.message`, never `cause`.
 */
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

/**
 * Thrown when a held instrument's mark is too old to value the book with. A
 * named type, not a bare `Error`, so a caller can tell "feed alive and
 * lying" apart from a transport failure without matching on message text —
 * the two warrant different operator-alert severity. Carries the numbers so
 * the log line states how stale, not just that it was.
 */
export class StaleMarkError extends BookValuationError {
  constructor(
    readonly instrument: string,
    readonly observed_at: Date,
    /** When the mark was RECEIVED — the coordinate freshness is judged at */
    readonly readAt: Date,
    /** The tick's point-in-time coordinate, carried for the pass-duration it implies */
    readonly asOf: Date,
    readonly freshness: Exclude<MarkFreshness, { status: 'fresh' }>,
  ) {
    // `stale` means the market went quiet; `ahead` means our clock and the
    // venue disagree, which pass latency cannot explain
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

/**
 * Fails closed on a missing mark instead of defaulting to zero. Unreachable
 * today (`readMarks` already throws on any unvalued instrument), but guards
 * against a future instrument-key mismatch silently reporting a position as
 * zero exposure — which would hand Risk a green light it should refuse.
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
 * side-signed so a short gains when the mark falls. `filled_size` not
 * `requested_size` (cross-spec §4) — an unfilled lot carries no PnL, and
 * `avg_entry_price` is 0 until the first fill lands.
 */
export function unrealizedFor(position: OpenPosition, mark: number): number {
  const direction = position.side === 'buy' ? 1 : -1;
  return (mark - position.avg_entry_price) * position.filled_size * direction;
}

/**
 * States whose unfilled remainder is RESERVED against entry caps — see
 * `PortfolioView.reserved_exposure_by_instrument`. DERIVED from
 * `IN_FLIGHT_ORDER_STATES` rather than duplicated: `reconcile()`'s bracket
 * pass is the only mechanism that ever releases one of these off broker
 * truth, so a state reserved here but missing there would block its cap
 * with no release path.
 */
const RESERVABLE_ORDER_STATES: ReadonlySet<OpenPosition['order_state']> = new Set(
  IN_FLIGHT_ORDER_STATES,
);

/**
 * Notional committed to the venue and not yet received: the unfilled
 * remainder at mark, or 0 once the order is no longer in flight. Clamped to
 * 0 so an overfill (`filled_size` > `requested_size`, recorded rather than
 * rejected by `ingest-fills.ts`) can never hand the caps negative headroom.
 *
 * Also reserves a wedged zero-fill lot (`isWedgedZeroFillLot`) — invisible
 * to `RESERVABLE_ORDER_STATES`/`exposure_by_instrument` otherwise — which
 * releases via the same real fill or `WEDGED_ZERO_FILL_ABANDON_AFTER_MS`
 * abandon that `wedged-zero-fill-sweep.ts` relies on. INVARIANT:
 * `sqlite-shared-store.ts`'s abandon UPDATE restates this predicate in raw
 * SQL rather than sharing it; widen it here without updating that SQL and
 * the reservation strands past 24h.
 */
function reservedNotional(position: OpenPosition, mark: number): number {
  if (!RESERVABLE_ORDER_STATES.has(position.order_state) && !isWedgedZeroFillLot(position)) {
    return 0;
  }
  return Math.max(position.requested_size - position.filled_size, 0) * mark;
}

/**
 * Completes one class's daily PnL: `(realized + unrealized) / open_equity`.
 * An unknown basis stays unknown rather than defaulting to 0 — no arithmetic
 * recovers a denominator nobody recorded. The unrealized term is each lot's
 * lifetime gain, not its gain since the session open (no boundary mark is
 * stored), so a held position carries in yesterday's PnL too — conservative
 * for a loss breaker but an approximation, which is why the three per-class
 * figures need not reconcile.
 */
function dailyPnlFor(basis: SessionBasis, unrealized: number): DailyPnl {
  if (!basis.known) {
    return { known: false, reason: basis.reason };
  }

  return { known: true, pct: (basis.realized_pnl + unrealized) / basis.open_equity };
}

/**
 * Every held instrument's mark, in ONE batch read, or nothing.
 *
 * `getMarks` reports every instrument's outcome — unlike a per-instrument
 * `Promise.all`, which would discard every result but the one that lost the
 * race — and this folds the unreadable and the STALE ones (staleness judged
 * here since the per-class bound lives here, not in MDS) into a single
 * report naming all of them.
 *
 * Total refusal is correct on the ENTRY path: every consumer of
 * `exposure_by_instrument` reads an absent key as ZERO exposure, so a
 * partial view is never conservative there. It is wrong on the EXIT path,
 * where refusing to value the book suppresses a flatten and one dark name
 * blocks the whole book's flatten — `unvaluable_marks: 'exclude'` returns
 * the valued subset plus the unvalued names instead of throwing. The caller
 * picks the policy per intent type in the composition root; this function
 * cannot see whether an order is opening or closing.
 *
 * A lone failure throws on its own, not wrapped in an `AggregateError` of
 * one, so `StaleMarkError`'s "feed alive and lying" signal still reaches a
 * caller matching on type. Every thrown message is self-sufficient: the only
 * place these are observed is `describeThrown` (safe-log.ts), which prints
 * `error.message` alone — never `cause`, never `AggregateError.errors`.
 */
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
  // Taken once after the whole batch resolves, and applied to every mark —
  // this is the instant the view VALUES the book, not an approximation of a
  // per-mark read time. Judging each mark at its own arrival would call a
  // price fresh that no longer is by the time it reaches the exposure math.
  const readAt = clock.now();

  const marks = new Map<string, number>();
  const failures: BookValuationError[] = [];

  for (const instrument of instruments) {
    const read = reads.get(instrument);
    if (read === undefined) {
      // Omitted from the batch response — treated the same as a read
      // failure since either way the book has an unvalued position. Typed
      // as `MarkReadError` so a `BookValuationError` narrow still catches it.
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
      // Re-wrapped, not re-thrown as-is: a source error need not name the
      // instrument ('request timed out'), and the operator needs to know
      // which position is unvalued. Reason folded into the MESSAGE, not left
      // to `cause` — `describeThrown` prints the message alone.
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

    // Fail closed on a STALE mark too, not just a missing one — a mark
    // arriving isn't evidence the feed is alive (TTL cache, halted/thin
    // instrument repeating its last trade). Collected rather than thrown on
    // sight, so one stale name doesn't hide a second dark one from the report.
    const assetClass = classByInstrument.get(instrument) ?? read.mark.asset_class;
    const freshness = classifyMarkFreshness(read.mark, readAt, max_mark_age[assetClass]);
    if (freshness.status !== 'fresh') {
      failures.push(new StaleMarkError(instrument, read.mark.observed_at, readAt, asOf, freshness));
      continue;
    }

    marks.set(instrument, read.mark.price);
  }

  const unvalued = [...classByInstrument.keys()].filter((instrument) => !marks.has(instrument));

  // EXIT policy: same reads and staleness judgement as above, just returned
  // instead of thrown. Caller must make the degradation audible — see
  // `ExitValuationDegradedAlertChannel` (orchestrator/production).
  if (policy === 'exclude') {
    return { marks, unvalued };
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    const named = unvalued.map((instrument) => `'${instrument}'`).join(', ');
    // Folded in for the same reason as the single-failure wrap:
    // `AggregateError.errors` is never printed, so reasons must be in the message.
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

  // Taken from POSITIONS, not the returned `Mark.asset_class` — the freshness
  // bound is a property of what we hold; reading it off the source's own
  // answer would let a mis-classified mark pick the more permissive bound.
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
  // Same single pass as the exposure math, over the same `marks` map — the
  // marks must be fetched once, and this is what makes that true
  const unrealized_by_class: Record<AssetClass, number> = { crypto: 0, stocks: 0 };

  for (const position of positions) {
    // An unvalued position contributes NOTHING to any figure — understated,
    // not conservative — which is why `unvalued_instruments` travels on the
    // view and why `RiskManagerImpl.evaluate` refuses an ENTRY that sees a
    // non-empty one.
    if (unvalued.includes(position.instrument)) continue;
    // Cross-spec Freeze §4: VALUATION is always filled_size, never
    // requested_size — an unfilled lot is worth nothing to equity/PnL.
    // RESERVATION (below) asks a different question of the same row; see
    // `PortfolioView.reserved_exposure_by_instrument`.
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
