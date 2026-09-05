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
 * it in the account provider instead would mean a second round of mark reads
 * for the same instruments at the same instant.
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
import type { DailyPnl, PortfolioView, SessionBasis, SessionBasisByClass } from './types.js';

export interface PortfolioAccountingInput {
  positions: OpenPosition[];
  marketData: MarketDataService;
  /** Point-in-time read for every mark lookup — never wall-clock. */
  asOf: Date;
  /**
   * Reads the instant the marks came back, which is when this view VALUES the
   * book — the coordinate feed freshness is judged at (#1111).
   *
   * Required rather than defaulted to `asOf`, and required rather than
   * optional: a caller that skips it is a caller measuring freshness from the
   * tick's start instant again, and the whole defect #1111 fixes is that the
   * gap between those two instants is unbounded — 145s in the 2026-09-04 paper
   * session, against a 5000ms tolerance. A compile error at every call site is
   * how that stays fixed.
   *
   * Injected rather than read off `Date.now()` so backtest stays deterministic:
   * the replay driver advances its `SimulatedClock` to the bar BEFORE the tick
   * and never within one, so `clock.now()` there is `asOf` and this change is
   * inert in replay.
   */
  clock: Clock;
  cash: number;
  peak_equity: number;
  /**
   * Per-class session-open equity and realized PnL since that open (#332).
   * The unrealized half is added here, from the marks fetched below.
   */
  daily_basis: SessionBasisByClass;
  /** Realized, from fills — not computed here (#83). */
  consecutive_losses: number;
  /**
   * FEED staleness bound per asset class (#640): max `asOf -
   * Mark.observed_at` for a mark used to value a held position.
   *
   * Required, not optional-with-a-default. This function's answer feeds every
   * exposure cap, the drawdown breaker and the daily-loss breaker, so a
   * default here would be a risk limit chosen by omission — and the caller
   * that forgets it is exactly the caller whose marks nobody is watching. A
   * required field makes each such site a compile error instead.
   *
   * Its own field rather than a shared object with `VerdictConfig.max_mark_age`
   * (see `mark-freshness.ts`): the two gate different things — one
   * instrument's mark at fire time versus every held instrument's valuation
   * mark — and may legitimately want different numbers, since refusing to
   * VALUE the book is a much heavier action than declining one trade.
   */
  max_mark_age: Record<AssetClass, number>;
  /**
   * What to do with a held instrument whose mark cannot be read or is stale
   * (#841).
   *
   * - `'refuse'` (the default): throw, producing NO view at all. The ENTRY
   *   path's posture, unchanged — sizing an entry needs the whole book
   *   priced, because every cap reads an absent instrument as zero exposure
   *   and is more permissive for it.
   * - `'exclude'`: leave the unvaluable positions out of every figure and
   *   name them in `PortfolioView.unvalued_instruments`. The EXIT path's
   *   posture: flattening a position already held does not need the rest of
   *   the book priced, and refusing the view there suppressed the flatten of
   *   every other name — including names whose marks were perfectly fresh —
   *   leaving leveraged ETPs (ADR-0016) on overnight against ADR-0014's
   *   flat-by-close invariant.
   *
   * Optional with a default, unlike `max_mark_age` above, and deliberately:
   * the default is the CONSERVATIVE value, so a caller that forgets this
   * field gets the total refusal it always got. The dangerous direction here
   * is opting IN, which is explicit at every site and grep-able.
   */
  unvaluable_marks?: UnvaluableMarkPolicy;
}

/** See `PortfolioAccountingInput.unvaluable_marks`. */
export type UnvaluableMarkPolicy = 'refuse' | 'exclude';

/**
 * Base for every reason `computePortfolioView` refuses to value a held
 * instrument (#640, widened #1089) — the common type a caller narrows on to
 * catch "the book could not be valued" without matching on message text
 * (docs/coding-standards.md, "Typed errors only where a caller branches").
 *
 * `decide.ts`'s `buildBracket` is that caller: it converts a whole-book
 * valuation refusal into a named skip on the control arm while letting every
 * OTHER rejection (e.g. `sizingEquity`'s #569 non-finite-ceiling guard)
 * propagate unchanged on either arm. `readMarks` below has two failure
 * shapes under this base — a stale mark (`StaleMarkError`) and a mark that
 * could not be read at all (`MarkReadError`: feed timeout, unknown symbol,
 * or a batch response omitting the instrument) — reaching `buildBracket`
 * bare, either directly (`failures.length === 1`) or folded into an
 * `AggregateError` (`failures.length > 1`). `readMarks`'s own wrap is always
 * all-`BookValuationError` members, but `decide.ts`'s caller narrows on that
 * explicitly rather than trusting the wrapper type alone — `AggregateError`
 * is a JS built-in any opaque thunk can reject with, so the caller inspects
 * `.errors` and requires every member be a `BookValuationError` before
 * treating it as a valuation refusal. A single base class still means the
 * caller enumerates a PREDICATE, not a list of subclasses.
 */
export abstract class BookValuationError extends Error {}

/**
 * Thrown when a held instrument's mark could not be obtained at all — the
 * batch read omitted it, or the source rejected the individual lookup
 * (timeout, unknown symbol). Distinct from `StaleMarkError`: this means "no
 * price", not "a price we don't trust any more" — the feed may simply be
 * unreachable, which is not the "alive and lying" signal `StaleMarkError`
 * carries. `cause` holds the source error where there was one (the omitted-
 * entry case has none); the MESSAGE always carries the reason too, since
 * `describeThrown` (safe-log.ts) prints only `error.message` and never
 * `cause`.
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
 * Thrown when a held instrument's mark is too old to value the book with
 * (#640).
 *
 * A named type rather than a bare `Error` because the caller has to be able to
 * tell this apart from a transport failure without matching on message text:
 * both abort the pass, but only this one means "the feed is alive and lying",
 * which is the signal an operator alert should escalate on differently from a
 * timeout. It carries the numbers so the log line can say how stale, not just
 * that it was stale.
 */
export class StaleMarkError extends BookValuationError {
  constructor(
    readonly instrument: string,
    readonly observed_at: Date,
    /** When the mark was RECEIVED — the coordinate freshness is judged at (#1111). */
    readonly readAt: Date,
    /** The tick's point-in-time coordinate, carried for the pass-duration it implies. */
    readonly asOf: Date,
    readonly freshness: Exclude<MarkFreshness, { status: 'fresh' }>,
  ) {
    // #1111: the two statuses are two different faults and each says only its
    // own. `stale` is the market having gone quiet; `ahead` is our clock and
    // the venue's disagreeing AFTER the mark was already in hand, which pass
    // latency can no longer explain at any magnitude — the pre-#1111 wording
    // asserted that disagreement for an offset that was only our own elapsed
    // time between `asOf` and the read.
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
 * Fails closed on a missing mark instead of defaulting to zero.
 *
 * Unreachable today — `marks` is built from exactly the instruments held, and
 * `readMarks` below has already thrown if any of them could not be valued. The
 * guard is here for the day that stops being true (an instrument-key
 * normalization mismatch between the store and the data service is the obvious
 * way in): a zero mark silently reports a real position as zero exposure,
 * which understates gross exposure and drawdown and hands Risk a green light
 * for a trade it would otherwise block. For a view whose entire job is
 * bounding risk, "I don't know" must stop the sweep, not read as "nothing
 * there".
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

/**
 * Every held instrument's mark, in ONE batch read, or nothing (#289 H8).
 *
 * All-or-nothing is NOT new here — the `Promise.all` over N `getMark` calls
 * this replaces already rejected the whole view on any failed OR stale read.
 * What is new is the batch shape and the failure REPORT: `Promise.all` kept
 * whichever lookup lost the race and discarded the rest, so a feed outage
 * across three names showed the operator one. `getMarks` returns every
 * instrument's outcome, and this folds the unreadable and the STALE ones
 * (#640, judged here because the per-class bound lives here and not in MDS)
 * into a single report naming all of them.
 *
 * Keep the refusal total ON THE ENTRY PATH. A partial view is not a
 * conservative one there: every consumer of `exposure_by_instrument` reads an
 * absent key as ZERO exposure and is more permissive for it — enumerated on
 * `MarketDataService.getMarks` (providers/market-data-service/types.ts), not
 * re-derived here. That makes no order more likely to be placed on the ENTRY
 * path, which is where this refusal was reasoned about.
 *
 * It was never true of the EXIT path, where refusing to value the book
 * SUPPRESSES a flatten and one dark name blocks the flatten of the whole
 * book. #841 split the two: `unvaluable_marks: 'exclude'` keeps the reads and
 * the report identical but returns the valued subset plus the names it could
 * not value, instead of throwing. Which policy applies is the CALLER's choice
 * and is made per intent type in the composition root — never inferred here,
 * because this function cannot see whether an order is being opened or closed.
 *
 * A single failure is thrown ON ITS OWN rather than inside an `AggregateError`
 * of one, so `StaleMarkError`'s "the feed is alive and lying" signal still
 * reaches a caller matching on the type rather than on message text — the
 * reason that class exists.
 *
 * Every thrown message must be SELF-SUFFICIENT. The only place these are ever
 * observed is `describeThrown` (safe-log.ts), which prints `error.message` and
 * nothing else — never `cause`, never `AggregateError.errors`. A source reason
 * not folded into the message text is a reason the operator never sees.
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
  // #1111: taken once, after the whole batch resolves, and applied to every
  // mark in it. Not an approximation of a per-mark read instant — it is the
  // instant this view VALUES the book, and a mark fetched early in a batch
  // that took a minute genuinely is a minute old by the time its price reaches
  // the exposure arithmetic. Judging each mark at its own arrival would call a
  // price fresh that is not fresh any more at the moment it is used, which is
  // the direction #640 exists to refuse.
  const readAt = clock.now();

  const marks = new Map<string, number>();
  const failures: BookValuationError[] = [];

  for (const instrument of instruments) {
    const read = reads.get(instrument);
    if (read === undefined) {
      // A service that answered the batch but omitted an instrument it was
      // asked for. Not distinguished from a read failure here: either way this
      // book has an unvalued position in it. Typed `MarkReadError`, not a
      // bare `Error`, so a caller narrowing on `BookValuationError` (#1089)
      // catches this shape too.
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
      // Re-wrapped rather than re-thrown as the source threw it, because a
      // data-source error need not name the instrument it was for ('request
      // timed out' is a real message), and a single-failure report that cannot
      // say WHICH held position is unvalued sends the operator looking through
      // the whole book. The source reason is folded into the MESSAGE, not left
      // to `cause`: `describeThrown` prints the message alone, so a reason that
      // travels only as `cause` is a reason the operator never reads.
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

    // #640: fail closed on a STALE mark, not merely on a missing one.
    //
    // A mark ARRIVING is not evidence the feed is alive — in live it may serve
    // from a TTL cache, and a halted or thin instrument keeps returning its
    // last trade indefinitely. Valuing the book off that price is the failure
    // the Risk Manager exists to prevent: exposure, drawdown and daily PnL are
    // all computed from these marks, so a frozen price silently freezes the
    // drawdown breaker at whatever it read last and hands every cap a number
    // that stopped being true.
    //
    // Collected rather than thrown on sight, so one stale name does not hide a
    // second dark one from the same report.
    const assetClass = classByInstrument.get(instrument) ?? read.mark.asset_class;
    const freshness = classifyMarkFreshness(read.mark, readAt, max_mark_age[assetClass]);
    if (freshness.status !== 'fresh') {
      failures.push(new StaleMarkError(instrument, read.mark.observed_at, readAt, asOf, freshness));
      continue;
    }

    marks.set(instrument, read.mark.price);
  }

  const unvalued = [...classByInstrument.keys()].filter((instrument) => !marks.has(instrument));

  // #841: the EXIT path takes the valued subset and the list of names it
  // could not value, rather than nothing at all. The reads, the staleness
  // judgement and the per-instrument reasons above are IDENTICAL under both
  // policies — the only difference is whether the report is thrown or
  // returned. The caller is responsible for making the degradation audible;
  // see `ExitValuationDegradedAlertChannel` (orchestrator/production).
  if (policy === 'exclude') {
    return { marks, unvalued };
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    const named = unvalued.map((instrument) => `'${instrument}'`).join(', ');
    // Each failure's own text is folded in for the same reason as the
    // single-failure wrap above: `AggregateError.errors` is printed nowhere, so
    // a report naming the instruments but not the reasons tells the operator
    // which positions are dark and nothing about why.
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

  // The asset class each held instrument is valued under, so the freshness
  // bound below can be the right one per class. Taken from the POSITIONS
  // rather than from the returned `Mark.asset_class`: the bound is a property
  // of what we hold, and reading it off the data source's own answer would let
  // a mis-classified mark select the more permissive bound for itself.
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
  // Same single pass as the exposure math, over the same `marks` map — #332
  // requires the marks be fetched once, and this is what makes that true.
  const unrealized_by_class: Record<AssetClass, number> = { crypto: 0, stocks: 0 };

  for (const position of positions) {
    // #841: a position the caller allowed to go unvalued contributes NOTHING
    // to any figure — no exposure, no unrealized PnL. That is understated, not
    // conservative, which is exactly why `unvalued_instruments` travels on the
    // view and why `RiskManagerImpl.evaluate` refuses an ENTRY that sees a
    // non-empty one. Under the default `'refuse'` policy this list is empty
    // and the loop is byte-for-byte what it was.
    if (unvalued.includes(position.instrument)) continue;
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
    unvalued_instruments: unvalued,
  };
}
