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
import { isMarkStale, type MarketDataService } from '../../providers/market-data-service/index.js';
import { type AssetClass, describeThrown, type OpenPosition } from '../../shared/index.js';
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
export class StaleMarkError extends Error {
  constructor(
    readonly instrument: string,
    readonly observed_at: Date,
    readonly asOf: Date,
    readonly max_age_ms: number,
  ) {
    const ageMs = asOf.getTime() - observed_at.getTime();
    super(
      `computePortfolioView: mark for held instrument '${instrument}' was observed ` +
        `${observed_at.toISOString()}, ${ageMs}ms before ${asOf.toISOString()}, which exceeds ` +
        `the ${max_age_ms}ms bound for its asset class` +
        (ageMs < 0 ? ' (the mark is AHEAD of our clock — the two disagree)' : '') +
        '. Refusing to value the book on a price the market may no longer support: exposure, ' +
        'drawdown and daily PnL all derive from these marks, so a frozen price freezes every ' +
        'risk limit that reads them.',
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
 * Keep the refusal total. A partial view is not a conservative one: every
 * consumer of `exposure_by_instrument` reads an absent key as ZERO exposure
 * and is more permissive for it — enumerated on `SubclassDeploymentCap` in
 * types.ts, not re-derived here. That makes no order more likely to be placed
 * on the ENTRY path, which is where this refusal was reasoned about. It is NOT
 * true of the EXIT path, where refusing to value the book suppresses a flatten
 * and one dark name blocks the flatten of the whole book — #841.
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
  max_mark_age: Record<AssetClass, number>,
): Promise<Map<string, number>> {
  const instruments = [...classByInstrument.keys()];
  const reads = await marketData.getMarks(instruments, asOf);

  const marks = new Map<string, number>();
  const failures: Error[] = [];

  for (const instrument of instruments) {
    const read = reads.get(instrument);
    if (read === undefined) {
      // A service that answered the batch but omitted an instrument it was
      // asked for. Not distinguished from a read failure here: either way this
      // book has an unvalued position in it.
      failures.push(
        new Error(
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
        new Error(
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
    if (isMarkStale(read.mark, asOf, max_mark_age[assetClass])) {
      failures.push(
        new StaleMarkError(instrument, read.mark.observed_at, asOf, max_mark_age[assetClass]),
      );
      continue;
    }

    marks.set(instrument, read.mark.price);
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    const named = [...classByInstrument.keys()]
      .filter((instrument) => !marks.has(instrument))
      .map((instrument) => `'${instrument}'`)
      .join(', ');
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

  return marks;
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
    max_mark_age,
  } = input;

  // The asset class each held instrument is valued under, so the freshness
  // bound below can be the right one per class. Taken from the POSITIONS
  // rather than from the returned `Mark.asset_class`: the bound is a property
  // of what we hold, and reading it off the data source's own answer would let
  // a mis-classified mark select the more permissive bound for itself.
  const classByInstrument = new Map<string, AssetClass>(
    positions.map((position) => [position.instrument, position.asset_class]),
  );

  const marks = await readMarks(marketData, classByInstrument, asOf, max_mark_age);

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
