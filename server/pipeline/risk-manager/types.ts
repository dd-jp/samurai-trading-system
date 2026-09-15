/**
 * Domain types for the Risk Manager (Stage 4) core check pipeline.
 * See docs/specs/risk-manager-spec.md ("Key Interfaces", "Module: Check
 * Pipeline") and docs/specs/cross-spec-contracts.md. Implementation ticket
 * #76 — the pipeline only. `PortfolioView` computation is #78; breaker-trip
 * computation is #77 — both are consumed here as pre-built inputs.
 */
import type { BarWindow, IndicatorSpec } from '../../providers/market-data-service/index.js';
import type { Clock, InstrumentSubclass, OrderIntent } from '../../shared/index.js';

/**
 * Pre-computed breaker trip state, tiered per risk-manager-spec.md
 * ("Module: Circuit Breakers"). Computing *when* a breaker trips is #77;
 * the pipeline here only reads the current armed/tripped state and halts
 * new entries accordingly. Exits are never gated by breakers.
 */
export interface BreakerState {
  portfolio_tripped: boolean;
  asset_class_tripped: {
    crypto: boolean;
    stocks: boolean;
  };
  /** Human/audit-facing names of every currently armed breaker, e.g. 'portfolio_drawdown_hard'. */
  armed_breakers: string[];
}

/**
 * Crash-restart-safe row shape for the sticky breakers (hard drawdown +
 * kill-switch) — one row per tier, matching the `breaker_state` table in
 * shared-sqlite-store-spec.md (ticket #203). Unlike `BreakerState` (a
 * derived, per-evaluate-call view with no timestamps), this shape is
 * lossless: `CircuitBreakers` can be reconstructed from it exactly,
 * which is what makes trip state survive a process restart.
 */
export interface PersistedBreakerState {
  tier: 'portfolio_drawdown' | 'kill_switch';
  tripped: boolean;
  tripped_at: Date | null;
  reset_at: Date | null;
  reason: string | null;
}

/**
 * Session-scoped daily PnL, as a fraction (-0.05 is a 5% loss) — or an
 * explicit "not known" (#332).
 *
 * A discriminated union, NOT `number | null`, and deliberately so. The daily
 * loss breaker's test is `pct <= -config.daily_loss_pct`; JavaScript coerces
 * both `null` and `undefined` in that comparison (`null <= -0.05` evaluates
 * `0 <= -0.05` → `false`), so a nullable number would read an unknown figure as
 * *flat* and silently leave the breaker un-tripped through a real loss. With a
 * tagged union there is no numeric coercion path at all: `pct` is unreachable
 * until `known` has been narrowed, which makes "unknown treated as zero" a
 * compile error at every consumer rather than a runtime near-miss.
 *
 * `reason` is operator-facing — it names why the figure is absent, so a halted
 * session is diagnosable without reading code.
 */
export type DailyPnl =
  | { readonly known: true; readonly pct: number }
  | { readonly known: false; readonly reason: string };

/**
 * Daily PnL per session boundary (#332). The three figures are measured from
 * DIFFERENT boundaries — crypto from 00:00 UTC, stocks from the prior 16:00 ET
 * close, portfolio from 00:00 UTC — each against its own class's equity at that
 * boundary.
 *
 * They therefore do NOT sum to one another, by design, and no invariant should
 * be asserted between them: `crypto + stocks === portfolio` is false whenever a
 * stock trade closes between Friday 16:00 ET and Saturday 00:00 UTC.
 */
export interface DailyPnlByClass {
  readonly crypto: DailyPnl;
  readonly stocks: DailyPnl;
  readonly portfolio: DailyPnl;
}

/**
 * Accounting view over the shared store (#78). Consumed here read-only —
 * the pipeline never computes exposure/drawdown itself.
 */
export interface PortfolioView {
  equity: number;
  peak_equity: number;
  drawdown_pct: number;
  exposure_by_instrument: Record<string, number>;
  exposure_by_class: { crypto: number; stocks: number };
  gross_exposure: number;
  /**
   * Notional of orders SUBMITTED but not yet filled, at mark, per instrument
   * (#1019). Disjoint from `exposure_by_instrument` — that one values what is
   * held (`filled_size`), this one values what has been committed to the
   * venue and has not come back yet (`requested_size - filled_size` on a
   * `pending`/`submitted` lot).
   *
   * **This is the submit-time reservation, and the write-ahead row IS the
   * ledger.** `execute.ts` writes an `OpenPosition` with `filled_size: 0`
   * BEFORE it calls the broker, and `ingestFills()` advances it on its own
   * 15s poll. Between those two instants the lot valued at `filled_size`
   * alone is worth ZERO to every exposure cap, so a second instrument
   * evaluated in that window nets against nothing and reaches the same
   * subclass/class/gross envelope independently. #1040's tail turnstile
   * orders those evaluations but does not make the first one's exposure
   * VISIBLE to the second, and nothing orders passes across overlapping
   * ticks at all. Valuing the unfilled remainder here is what closes it:
   * `getOpenPositions()` is durable, arm-scoped and already excludes every
   * terminal state, so the reservation survives a restart and is released by
   * the fill or the terminalization rather than by a separate release path.
   *
   * **Scoped to `pending`/`submitted`, plus one narrow exception — the test is
   * a RELEASE PATH, not a time bound.** A `partially_filled` lot with real
   * progress (`filled_size > 0`) whose venue-side remainder is dead has no
   * mechanism that ever advances it: `ingestFills` recomputes only from a NEW
   * fill, and `sweepTerminalPositions` deletes only already-terminal rows.
   * Counting its remainder would strand a reservation that blocks the
   * subclass forever. `pending`/`submitted` are exactly the states
   * `reconcile()`'s bracket pass revisits (`IN_FLIGHT_ORDER_STATES`, which
   * `portfolio-view.ts` derives most of this scope from), and adopting broker
   * truth there is what releases the reservation — on a fill, on a `rejected`
   * for an order the venue never received, on any terminalization.
   *
   * The exception (#1568): a lot adopted `filled`/`partially_filled` at
   * submit time with `filled_size` STILL `0` — Saxo's `adopt` (or any
   * adapter) can ack a lookup hit in either state before a quantity is ever
   * known, and `execute.ts` writes that ack straight onto the row. This IS
   * reserved, at the full `requested_size`, because it has the release path
   * the general case above lacks: it is exactly `wedged-zero-fill-sweep.ts`'s
   * own selection, so either `ingestFills()` advances `filled_size` off zero
   * (ordinary exposure math takes over) or that sweep abandons the row after
   * `WEDGED_ZERO_FILL_ABANDON_AFTER_MS` — either way this reservation stops
   * applying. See `isAdoptedZeroFillLot` in `portfolio-view.ts`.
   *
   * That release is not on a clock. `reconcileLot` has no age-out: its
   * `undetermined` branch (the adapter threw, which is evidence of nothing)
   * deliberately writes nothing, and an order the venue genuinely reports as
   * still working stays `submitted` for as long as it rests. Both hold the
   * reservation open, and both are the SAFE direction — a resting order is
   * committed notional, and over-reserving on an adapter outage withholds
   * headroom rather than inventing it, the same asymmetry `reservedNotional`'s
   * `Math.max(…, 0)` is written for. The forced age-outs that do exist
   * elsewhere are each there because the aged row BLOCKS something — an
   * unresolved flatten-journal row blocks the mandatory flat-by-close
   * (`UNRESOLVABLE_FLATTEN_MAX_AGE_MS`), and a wedged zero-fill lot never
   * terminalizes at all (`WEDGED_ZERO_FILL_ABANDON_AFTER_MS`). A held
   * reservation blocks nothing comparable: it withholds headroom from the
   * subclass the resting order is already committed to.
   *
   * **Never folded into `gross_exposure`, `equity` or `drawdown_pct`, and
   * never into `BreakerEvalInput`.** `equity = cash + gross_exposure`, and
   * `cash` is the broker's own figure, which is not debited at submit time
   * either — adding the reservation to `gross_exposure` would inflate equity
   * by the reserved notional, double-counting the same order on both sides of
   * the balance and moving a STICKY drawdown breaker off a position that does
   * not exist yet. The reservation belongs strictly on the DEPLOYED side of
   * every `fraction × equity - deployed` cap in `index.ts`, which is where
   * `committedExposureFor` reads it.
   */
  reserved_exposure_by_instrument: Record<string, number>;
  reserved_exposure_by_class: { crypto: number; stocks: number };
  reserved_gross_exposure: number;
  /**
   * Replaces the former single `daily_pnl_pct: number`, which was Alpaca's
   * blended `last_equity` figure on an unverified boundary (GAP-8, #332).
   */
  daily_pnl: DailyPnlByClass;
  consecutive_losses: number;
  /**
   * Held instruments this view could NOT value, and therefore left out of
   * every figure above (#841). Empty on every fully-valued view, which is
   * every view the ENTRY path is ever allowed to see.
   *
   * Required rather than optional, and named on the view rather than passed
   * beside it, for the reason `DailyPnl` is a tagged union: a partial
   * valuation is indistinguishable from a complete one by inspection —
   * `exposure_by_instrument` simply has fewer keys, and every consumer reads
   * an absent key as ZERO exposure (see `readMarks` in portfolio-view.ts).
   * An optional field would let a partial view reach an entry gate as
   * `undefined` and read as "fully valued", which is the exact
   * absent-means-nothing-there failure the refusal exists to prevent. With it
   * required, `RiskManagerImpl.evaluate` can refuse an entry on a degraded
   * book and no producer can forget to say the book was degraded.
   *
   * Non-empty is reachable ONLY through
   * `PortfolioAccountingInput.unvaluable_marks: 'exclude'`, which the
   * composition root requests on the EXIT path alone — flattening a position
   * already held does not need the rest of the book priced, and refusing the
   * whole view there suppressed the flatten of every other name (ADR-0014's
   * flat-by-close is load-bearing).
   */
  unvalued_instruments: readonly string[];
}

/**
 * What the account layer knows about one session's starting point (#332), fed
 * to `computePortfolioView` so it can finish the division.
 *
 * The split of labour is deliberate: the account provider owns the durable
 * snapshot and the realized sum (it has the store and the calendars);
 * `computePortfolioView` owns the unrealized term, because it has already
 * fetched the marks and must not fetch them a second time.
 */
export type SessionBasis =
  | {
      readonly known: true;
      /** Portfolio equity at this class's session open — the denominator. */
      readonly open_equity: number;
      /** Realized PnL net of fees, for this class, since that open. */
      readonly realized_pnl: number;
    }
  | { readonly known: false; readonly reason: string };

export interface SessionBasisByClass {
  readonly crypto: SessionBasis;
  readonly stocks: SessionBasis;
  readonly portfolio: SessionBasis;
}

/**
 * Point-in-time pairwise correlation of one instrument against every other
 * held instrument with sufficient return history (ticket #50, v2 of the
 * concentration check — replaces the v1 static `ConcentrationBucket` list).
 * Computed outside `evaluate()` by `computeCorrelationEstimate` (correlation.ts)
 * and consumed here as pre-built data, mirroring `PortfolioView`/`BreakerState`.
 *
 * An instrument pair with insufficient overlapping history is still absent
 * from `correlations` rather than assigned a value — that omission IS the
 * warm-up fallback: the pipeline treats an absent entry as "not correlated"
 * rather than guessing. What #303 adds is that the omission is now NAMED, in
 * `insufficient_history`, so "we measured no correlation" and "we could not
 * measure" stop being the same observation to the caller. The fallback
 * behaviour is unchanged; only its visibility is.
 */
export interface CorrelationEstimate {
  /** Keyed by the OTHER instrument; value is its correlation with the intent's instrument. */
  correlations: Record<string, number>;
  /**
   * Held instruments dropped from `correlations` because the PAIR's
   * overlapping return history was under `CorrelationConfig.min_bars` (#303).
   *
   * A statement about the pair, not about the named instrument: overlap is
   * `min(target, other)`, so the thin side may be the intent's own instrument
   * — a brand-new listing being sized against a portfolio of long-established
   * holdings names every one of them here. Read an entry as "correlation with
   * X is unmeasurable", never as "X is new".
   *
   * Advisory only: the concentration check still cannot bind on these pairs,
   * so an entry here is a statement about what is UNKNOWN, never an input to
   * a trim. Present-but-empty means every held pair was measurable.
   */
  insufficient_history: string[];
}

/**
 * Static, config-driven thresholds the pipeline trims/rejects against.
 * Exact values are tuned in paper trading (risk-manager-spec.md "Out of
 * Scope: Exact limit values") — this is the shape, not the numbers.
 */
export interface RiskConfig {
  /**
   * Max notional for a single trade, as a FRACTION OF EQUITY resolved at
   * evaluate time (#886) — not a frozen cash amount, which is what this field
   * carried until #886's equity-relative amendment. Renamed rather than
   * reinterpreted in place: a bare `max_position_size` left every existing
   * cash-literal test fixture compiling and silently testing a 1000x-wider
   * cap once the unit changed underneath it.
   *
   * Skipped entirely for a D5-classified instrument with a numeric
   * `per_subclass_deployment_cap` fraction (`isD5ArmedWithNumericFraction` in
   * risk-manager/index.ts) — David's #886 ruling: "D5's own fraction … is
   * the sole drawdown authority once an instrument is subclass-classified."
   */
  max_position_size_fraction_of_equity: number;
  /**
   * Max total notional exposure to one instrument, as a FRACTION OF EQUITY
   * resolved at evaluate time (#886).
   *
   * Skipped entirely for a D5-classified instrument with a numeric
   * `per_subclass_deployment_cap` fraction (`isD5ArmedWithNumericFraction` in
   * risk-manager/index.ts) — #932, extending #886's ruling to this cap: D5
   * caps DEPLOYMENT into one subclass and this cap caps EXPOSURE to one
   * instrument, not the same claim, but #886 left this one at 10% — tighter
   * than either D5 fraction (35%/25%) — so a full-envelope D5 entry was still
   * trimmed here, just at a different gate than the one #886 fixed. Once an
   * instrument is D5-classified, D5 is the sole per-instrument drawdown
   * authority for it on this axis too.
   *
   * Once this cap is skipped, `per_subclass_deployment_cap` is the sole
   * per-instrument *deployment-fraction* bound left for a D5-classified
   * instrument — including when MULTIPLE instruments in the same subclass
   * are armed concurrently, which that field's gate
   * (`perSubclassDeploymentCap`, risk-manager/index.ts) nets across rather
   * than bounding independently. `concentration.cap_fraction_of_equity`
   * (below, via `concentrationCorrelationCap`) is a second, independent
   * bound — correlation-based, not deployment-based — that still applies to
   * a D5-classified instrument unchanged.
   */
  per_asset_cap_fraction_of_equity: number;
  /** Max total notional exposure per asset-class bucket, as a FRACTION OF EQUITY resolved at evaluate time (#886). */
  per_asset_class_cap_fraction_of_equity: { crypto: number; stocks: number };
  /** Max total gross notional exposure across the portfolio, as a FRACTION OF EQUITY resolved at evaluate time (#886). */
  portfolio_gross_cap_fraction_of_equity: number;
  /** v2 dynamic concentration check (#50) — caps combined exposure across the intent's instrument and every instrument correlated with it. */
  concentration: {
    /** Max combined notional exposure across the intent's instrument and everything correlated with it, as a FRACTION OF EQUITY resolved at evaluate time (#886). */
    cap_fraction_of_equity: number;
    /** |correlation| at/above which another instrument counts as concentrated risk with this one. */
    threshold: number;
  };
  /** Below this notional, a trimmed intent is dust and must be rejected. */
  min_viable_size: number;
  /**
   * Quantise an APPROVED entry size to whole shares (#941). Mirrors
   * `TraderConfig.whole_share_sizing` and must be set to the same value: the
   * two are one venue constraint applied at the two places a size is set.
   *
   * The Trader's floor is necessary but not sufficient. Every cap gate here
   * trims a NOTIONAL, and the approved size is re-derived as
   * `notional / intent.entry` — so a whole-share entry of 93 that any gate
   * binds on comes back out as, say, 71.4, and Alpaca refuses the bracket
   * with `422 42210000 fractional orders must be simple orders` exactly as it
   * did before the Trader was fixed. The trim, not the Trader, is then the
   * proximate cause of an unsubmittable order.
   *
   * Trims only ever reduce, and flooring only ever reduces, so composing them
   * cannot breach a cap the gates just enforced.
   */
  whole_share_sizing: boolean;
  /** CII soft signal (#205): absolute WorldMonitor CII level (0-100) above which a warning fires. Unpinned, tuned in paper trading. */
  cii_threshold: number;
  /**
   * #640: max age of a mark used to VALUE a held position, per asset class,
   * before `computePortfolioView` refuses to produce a view at all.
   *
   * A risk bound rather than a data-service one. Every number the Risk
   * Manager gates on — gross exposure, per-class exposure, drawdown, daily
   * PnL — is computed from these marks, so a frozen price does not degrade
   * the view, it freezes every limit that reads it. The spec bills this stage
   * as "trusted absolutely under stress"; that claim needs the marks under it
   * to be current, and nothing checked until this field existed.
   *
   * `evaluate()` itself stays pure and synchronous and does NOT read this —
   * it never touches the data service. The bound binds where the reads
   * actually happen, which is `computePortfolioView`.
   */
  max_mark_age: Record<'crypto' | 'stocks', number>;
  /**
   * ADR-0018 D5's volatility-aware deployment envelope — the record's only
   * drawdown protection on the intraday product, and until this field existed,
   * unbuilt.
   *
   * Optional, and the optionality is the design. Absent means the gate does
   * not apply at all (`perSubclassDeploymentCap` returns `null`, exactly as
   * `concentrationCorrelationCap` does on an uncorrelated book), which is the
   * correct reading for the backtest harness and every test that predates
   * subclasses. Present means it is ARMED, and an instrument missing from
   * `subclass_of` then throws rather than sizing unbounded — off by default,
   * fails loud once declared.
   */
  per_subclass_deployment_cap?: SubclassDeploymentCap;
  /**
   * #888 review fix-up — the declared book, armed INDEPENDENTLY of universe
   * classification, unlike `per_subclass_deployment_cap.equity_ceiling`.
   *
   * `per_subclass_deployment_cap` (and the `equity_ceiling` nested inside it)
   * only exists once `d5EnvelopeFor` finds at least one classified instrument
   * (`subclassOfUniverse(universe)` non-empty) — and on the actual shipped
   * live composition root, `liveStartingProfile()` calls
   * `buildStartingProfileConfigs(undefined, LIVE_BOOK_GBP)`, which defaults to
   * `DEFAULT_UNIVERSE` (scheduler.ts), which carries NO subclass
   * classification today. So `per_subclass_deployment_cap` — and with it the
   * whole `equity_ceiling` clamp/refuse mechanism — is `undefined` on every
   * live tick until C1's LSE-ETP pool file lands (#703). This field is the
   * fix: set by `buildStartingProfileConfigs` whenever a book is supplied,
   * with no dependency on `subclass_of` at all, so `liveBookCeiling`
   * (risk-manager/index.ts) refuses an overfunded live account regardless of
   * whether any instrument happens to be D5-classified yet.
   *
   * Same shape as `SubclassDeploymentCap['equity_ceiling']` deliberately —
   * this is the account-level statement that one is the per-subclass
   * instance of, not a competing design.
   *
   * **Currency mismatch, guarded rather than merely flagged (#949).** `book`
   * is GBP (`LIVE_BOOK_GBP`); the only `AccountStateProvider` this repo ships
   * (`BrokerAccountStateProvider`, production/account-state.ts) reads
   * `portfolio.equity` from Alpaca's `GET /v2/account`, which is
   * USD-denominated with no FX conversion anywhere in this codebase — so a
   * numeric comparison of `portfolio.equity` against `book` compares GBP to
   * USD at whatever the prevailing rate happens to be, and neither passing
   * nor failing the tolerance check proves anything about real funding.
   * `same_currency_verified` is the guard: `liveBookCeiling`
   * (risk-manager/index.ts) refuses to arm — a distinct `currency_mismatch`
   * `binding_constraint`, not the `equity_exceeds_book` refusal below — for
   * as long as this is `false`/absent, regardless of what `portfolio.equity`
   * reads. #1180 decided the configured rate must not set it (below). The one
   * caller that may is `armSameCurrencyCeilings`
   * (orchestrator/production/saxo-funding.ts, #1509), and only when a real
   * `GET /port/v1/balances/me` reports the account denominated in the book's
   * own currency — never inferred from the venue being Saxo UK.
   *
   * **Why a configured rate does NOT lift this, now that one exists.** #1180
   * added `SIZING_USD_PER_GBP` (paper-profile.ts) — a static, code-configured
   * rate — and converted the Trader's sizing inlet with it. This gate is the
   * one place that rate must not reach, and the reason is the tolerance it
   * fires against. At `refuse_above_tolerance = 0.05` the gate refuses above
   * `book * 1.05`; convert the book at 1.27 while the true rate is 1.35 and
   * the effective threshold becomes `1000 * 1.27 * 1.05 / 1.35` ~= £988, so a
   * correctly funded £1,000 account refuses every entry. GBP/USD moves 6%
   * inside a quarter, which is enough to flip the outcome in either
   * direction. The asymmetry with the sizing inlet is the whole decision: a
   * 6% rate error there is a 6% sizing error, and here it is a total refusal
   * or a total miss — rate staleness would become indistinguishable from the
   * overfunding this refusal exists to catch.
   *
   * So the refusal stands until a LIVE rate feed exists, or the account is
   * read in the book's own currency — which is what #1509 wired, over Saxo's
   * `GET /port/v1/balances/me`. Setting it true is only correct on the
   * strength of that read, and never on the strength of a configured rate.
   */
  live_book_ceiling?: {
    /** The declared book (`LIVE_BOOK_GBP`), in GBP. */
    book: number;
    /** Same semantics as `SubclassDeploymentCap['equity_ceiling'].refuse_above_tolerance`. */
    refuse_above_tolerance: number;
    /** See the currency-mismatch paragraph above. Absent/`false` refuses to arm outright. */
    same_currency_verified?: boolean;
  };
  /**
   * #1511, David's 2026-09-14 decision: long-only book. The instruments a
   * `sell` that is not an exit must be refused on — every Saxo-venue name the
   * run is actually configured to trade, i.e. `saxoTradeableUniverse()`
   * (production/saxo-venue.ts), which is threaded here from
   * `paperStartingProfile`'s `bookCurrency === 'GBP'` branch (the one caller
   * `startingProfileForMode`, index.ts, supplies with `SAMURAI_BROKER=saxo`).
   *
   * NOT `asset_class === 'stocks'`. That was the first-pass discriminator and
   * it is wrong: it also catches the Alpaca paper universe (`DEFAULT_UNIVERSE`
   * — SPY/QQQ/AAPL/TSLA, scheduler.ts), which is `asset_class: 'stocks'` too
   * but trades on no venue this decision was ever asked about, and one round
   * of review measured it silently removing ~2/3 of entry intents from the
   * running 14-day soak on both arms.
   *
   * Also NOT `per_subclass_deployment_cap.subclass_of` membership: a Saxo
   * row's D5 subclass is only set once its bracket is MEASURED
   * (`liveSizingSubclassFor`), so an unmeasured-but-tradeable Saxo line would
   * be silently exempted from a refusal that has nothing to do with sizing.
   *
   * Absent means the gate does not apply — the same "off by default" idiom as
   * `per_subclass_deployment_cap` above, correct for every fixture and for
   * the unwidened `DEFAULT_UNIVERSE` paper/live path, which trades no Saxo
   * venue at all.
   */
  long_only_instruments?: ReadonlySet<string>;
}

/**
 * ADR-0018 D5, as config.
 *
 * D5 deploys a fixed fraction of the EQUITY LEG per subclass — ~35% to a 3x
 * index ETP, ~25% to a 3x single-stock ETP — holding measured max drawdown at
 * 23.1% and 26.2% respectively. Two properties of that envelope have to
 * survive into the code, because both are easy to round off:
 *
 * 1. **It is measured drift-removed with zero edge assumed.** The envelope
 *    therefore binds REGARDLESS of how good the signal turns out to be. It is
 *    not contingent on the indicator work or the threshold studies passing,
 *    and it must never become a dial the Feedback Loop can widen — see the
 *    deliberate absence from `RISK_THRESHOLD_KEYS` (risk-thresholds.ts), the
 *    allow-list backing the `risk_thresholds` table.
 * 2. **The single-stock fraction knowingly overshoots, and by more than D5
 *    published.** D5's rows were measured at the pre-neutral `SLS = {1.5, 3}`
 *    grid rather than at the brackets D3 declares and #724 froze; re-measured
 *    at the declared stops the envelope is ~26.2% (index, 35%) and ~41.8%
 *    (single-stock, 25%), so the recorded ~1.2 pp overshoot of CONTEXT.md's
 *    20-25% band is really ~17 pp (D5's #729 verification note, 2026-08-17).
 *    The fractions stay at 0.35 / 0.25 regardless: that note "records the
 *    measurement only", and re-sizing to the f ~= 0.332 / 0.142 that would
 *    hold the tolerance is an amendment nobody has made. Tightening either
 *    number here would be an unrecorded re-selection, which D4 forbids.
 */
export interface SubclassDeploymentCap {
  /**
   * Instrument -> the subclass ADR-0018 prices it under, sourced from the
   * universe at the composition root (the same place `assetClassOf` is built,
   * production/defaults.ts) rather than derived from the ticker string. There
   * is nothing in "3LAP" that says single-stock; only the pool file knows.
   */
  subclass_of: Readonly<Record<string, InstrumentSubclass>>;
  /**
   * Subclass -> max notional deployed to that subclass, as a FRACTION OF
   * CURRENT EQUITY resolved at evaluation time (#739) — not a frozen cash
   * amount, which is what this field carried until ADR-0018's sizing
   * amendment settled the basis.
   *
   * **The fractional form is what makes the drawdown bound keep bounding.** A
   * fixed £262 is 34.9% of a £750 book, 43.7% of £600 and 58.2% of £450, so
   * under a frozen amount exposure rises as a fraction of equity exactly as
   * equity falls and the envelope stops binding at the first loss. Because
   * exposure now shrinks after a loss, cumulative loss under this rule is
   * strictly smaller than under the fixed-cash deployment doc 18's rows
   * describe — D5's envelope figures are UPPER BOUNDS for what is implemented
   * here, not estimates of it.
   *
   * Each fraction IS D5's own per-subclass fraction (paper-profile.ts),
   * unscaled. D5 deploys a fraction of the EQUITY LEG and
   * `RiskPortfolioView.equity` is the whole account — and since 2026-08-18
   * those are the same thing: David's ruling on #800 re-based the book to
   * £1,000 all-equity, dissolving ADR-0015's £750/£750 split and with it the
   * `EQUITY_LEG_FRACTION_OF_CAPITAL = 0.5` that used to sit here.
   *
   * Total over `InstrumentSubclass` so a new subclass is a compile error here
   * rather than a silent absence, which on this gate would read as "no cap".
   * `null` is the explicit "D5 measured no envelope for this one" — it is not
   * a placeholder to be filled with a plausible number later. Today only
   * `crypto` is `null`: doc 18's study covers the two leveraged-ETP subclasses
   * and nothing else, and the crypto leg is parked out of the tick loop
   * (#705). `per_asset_class_cap_fraction_of_equity.crypto` still bounds it (#886 rename).
   */
  cap_fraction_of_equity: Readonly<Record<InstrumentSubclass, number | null>>;
  /**
   * #888 — the DECLARED BOOK this cap's fractions are fractions OF, resolved
   * against it rather than against raw `portfolio.equity`.
   *
   * `portfolio.equity` is one blended broker figure with no per-leg
   * accounting (`production/account-state.ts`), so it equals the declared
   * book only while the funding account happens to be funded at exactly that
   * figure. Above it, `cap_fraction_of_equity * portfolio.equity` authorises
   * proportionally more cash than the book was ever sized for — the gap #888
   * was filed for. Optional, and the optionality matters: every fixture in
   * `per-subclass-deployment-cap.test.ts` constructs a `SubclassDeploymentCap`
   * with no book at all, on purpose, to exercise the gate's netting/throwing
   * behaviour independent of any particular book — leaving this `undefined`
   * there preserves that. `d5EnvelopeFor` (paper-profile.ts) is the one
   * caller that sets it, at `LIVE_BOOK_GBP`, so it is load-bearing on the
   * profile actually shipped rather than on the gate in the abstract.
   */
  equity_ceiling?: {
    /**
     * The declared book (`LIVE_BOOK_GBP`) this cap's fractions resolve
     * against, in place of `portfolio.equity`, once equity has drifted past
     * it. GBP, same currency-mismatch caveat as `same_currency_verified`
     * below.
     */
    book: number;
    /**
     * Fractional headroom above `book` the gate tolerates before REFUSING the
     * entry outright (throwing) rather than merely capping resolution at
     * `book`. E.g. `0.05` refuses once `portfolio.equity` exceeds `book` by
     * more than 5%.
     *
     * The backstop half of #888's fix: capping resolution at `book` alone
     * closes the silent-widening gap, but an account funded far past the
     * declared book invalidates every OTHER sizing assumption too (the
     * breaker baselines, the drawdown envelope D5's fractions were measured
     * to hold) — so past a small tolerance this refuses to size the entry at
     * all instead of quietly treating the overfunding as harmless.
     */
    refuse_above_tolerance: number;
    /**
     * **Currency mismatch, guarded rather than flagged (#949) — same
     * mechanism as `RiskConfig['live_book_ceiling'].same_currency_verified`,
     * read that field's doc comment for the full account.** `book` is GBP;
     * `portfolio.equity` is read from Alpaca's USD-denominated
     * `GET /v2/account` (`alpacaFunding`, production/account-state.ts) on
     * every run but the Saxo venue's, so comparing the
     * two proves nothing about real funding regardless of which way the
     * tolerance check comes out. `perSubclassDeploymentCap`
     * (risk-manager/index.ts) refuses to arm — `binding_constraint` ending
     * `:currency_mismatch:<instrument>`, distinct from
     * `:equity_exceeds_book:<instrument>` below — for as long as this is
     * `false`/absent. #1180's configured `SIZING_USD_PER_GBP` deliberately
     * does not set it: its drift exceeds `refuse_above_tolerance`, so arming
     * with it would make FX movement indistinguishable from overfunding. The
     * one caller that may is `armSameCurrencyCeilings` (#1509), from a real
     * same-currency account read, and it arms this field and
     * `live_book_ceiling` together or neither.
     */
    same_currency_verified?: boolean;
  };
}

/**
 * What an invalidation condition is measured AGAINST — the vocabulary a
 * proposed condition may bind to (#994's fold of `devils-advocate-spec.md`
 * into the Risk Critic, per #997 Q1).
 *
 * Exactly the three reads the Risk step already performs deterministically at
 * decision time, off the `MarketDataService` it already holds for
 * `correlation.ts` and `portfolio-view.ts`. The 2026-08-05 proposal also had
 * an `mi_context` member; it is deliberately NOT here, because the Risk step
 * holds no Market Intelligence context store and the fold adds no data
 * dependency. A condition naming anything else is dropped
 * (`unknown_observable`), never evaluated.
 */
export type InvalidationObservable =
  | { kind: 'indicator'; spec: IndicatorSpec }
  | { kind: 'mark' }
  /** Latest bar's volume over the mean of the preceding bars in the window. */
  | { kind: 'bars'; window: BarWindow; measure: 'volume_ratio' };

/**
 * One falsifying predicate the critic PROPOSED. A model can only ever
 * construct this — never an `EvaluatedCondition` — which is what makes "the
 * LLM names what to check; deterministic code does the checking" a property of
 * the types rather than of a prompt instruction.
 *
 * No severity, weight or confidence, by spec: nothing model-assigned may reach
 * sizing or enforcement.
 */
/** The only comparators a condition may use. Declared once here; `invalidation.ts` validates against this same union. */
export type InvalidationComparator = '<' | '<=' | '>' | '>=';

export interface InvalidationCondition {
  id: string;
  observable: InvalidationObservable;
  comparator: InvalidationComparator;
  threshold: number;
  /** Why this falsifies the thesis. Free text, audit only — never machine-read. */
  rationale: string;
}

/**
 * Tri-state, derived MECHANICALLY. `unevaluable` means the read failed or
 * returned too little data — it is never a judgement, and it carries no
 * enforcement effect (a data gap must not block a trade).
 */
export type InvalidationConditionState = 'breached' | 'not_breached' | 'unevaluable';

/** A condition plus the measured fact about it. `observed` is null iff `unevaluable`. */
export interface EvaluatedCondition {
  condition: InvalidationCondition;
  state: InvalidationConditionState;
  observed: number | null;
}

/**
 * Why the deterministic validator refused a proposed condition. Persisted
 * rather than discarded (`devils-advocate-spec.md` user story 23): without
 * this, a systematically malformed prompt degrades into "conditions never
 * fire" and hides for a month.
 */
export type InvalidationDropReason =
  /** Not a readable condition object: blank id, non-finite threshold, unknown comparator, no rationale. */
  | 'unparseable'
  /** The `kind` is not one the Risk step can read deterministically at decision time. */
  | 'unknown_observable'
  /** The named indicator is not in the Market Data Service's `INDICATOR_KINDS` registry. */
  | 'unknown_indicator'
  /** `spec.lookback` (indicator) or `window.lookback` (bars) exceeds `MAX_INVALIDATION_LOOKBACK` — refused before it can trigger an unbounded market-data read (#994 review, PR #1067). */
  | 'lookback_too_large'
  /** The threshold is outside the observable's declared range, so the predicate is permanently true or permanently false. */
  | 'threshold_out_of_range'
  /** The condition would fire when the thesis is WORKING rather than failing. */
  | 'direction_incoherent'
  /** Beyond the 5-condition ceiling. Only the ceiling is enforced — a short list is recorded, never dropped. */
  | 'over_cap';

/** A refused condition, kept for audit. `id` is null when the emission was too malformed to carry one. */
export interface DroppedCondition {
  id: string | null;
  /** What the model said, bounded. Audit only. */
  raw: string;
  reason: InvalidationDropReason;
}

/** The red-team critic's verdict on one gated `OrderIntent` (ADR-0003, #204). Produced *outside* `evaluate()` by critic.ts (built by #957) and consumed here as pre-built data.
 *
 * `unavailable` is what a failed critic call PERSISTS (fail-open, per ADR-0003 §Consequences): the mechanical steps remain the safety net. It is
 * never handed to `evaluate()` — both producers map it back to `undefined`, so the decision keeps its explicit `risk_critic: skipped` reason and a
 * backtest replays the same "no verdict" input the live run had. `evaluate()` still handles the value defensively, since `RiskInput` is a public seam. */
export interface RiskCriticVerdict {
  verdict: 'pass' | 'trim' | 'reject' | 'unavailable';
  /** Only meaningful for `trim`: the notional the critic argues this intent should be capped at. */
  max_notional: number | null;
  /** The critic's argument text (audit). Surfaces on `RiskDecision.reasons`. */
  reasoning: string;
  /**
   * The invalidation half (#994, folding `devils-advocate-spec.md` in here per
   * #997 Q1). Emitted by the SAME single LLM call as the prose above, then
   * validated and evaluated by deterministic code in `invalidation.ts`.
   *
   * OPTIONAL, and absent-or-empty is ONE state — `no_conditions` — whatever
   * the cause: the model emitted none, every one was dropped, the conditions
   * half was unreadable, or the row was written before the fold and has no
   * such field at all (#997 Q3). All four report identically and enforce
   * nothing, so there is exactly one "nothing checkable came out" branch and a
   * pre-fold row replays to the same decision it always reached — same status,
   * size and `binding_constraint`, plus the one `no_conditions` reason line
   * that says the checklist enforced nothing.
   *
   * A malformed conditions half NEVER voids the prose verdict (#997 Q2a):
   * discarding a valid `reject` because the advisory half was garbage would
   * make the system strictly less safe than it is without the fold.
   */
  conditions?: EvaluatedCondition[];
  /** What the validator refused, with reasons. Surfaced on `RiskDecision.reasons` and persisted. */
  dropped_conditions?: DroppedCondition[];
}

/** Persisted critic row, keyed by `debate_id` — joined with `debate_log` and `cosine_setups` (#162). */
export interface RiskCriticLog {
  debate_id: string;
  verdict: RiskCriticVerdict;
  created_at: Date;
}

/** Port for the `debate_id`-keyed critic log. `SqliteRiskCriticStore` (critic-store.ts, migration 0032) is the production implementation — durable and
 * cross-process because ADR-0003 §2's replay-from-log means a `backtest` run reads what a `live`/`paper` run wrote; `InMemoryRiskCriticStore` beside it
 * serves tests and a root with no shared store. */
export interface RiskCriticStore {
  writeVerdict(entry: RiskCriticLog): void;
  getByDebateId(debate_id: string): RiskCriticLog | undefined;
}

export interface RiskInput {
  /** Cross-cutting correlation ID threaded from the Orchestrator's tick — not business data. */
  trace_id: string;
  intent: OrderIntent;
  clock: Clock;
  portfolio: PortfolioView;
  breakers: BreakerState;
  /**
   * Lossless sticky-breaker rows for this call, pre-computed by
   * `CircuitBreakers.getPersistedState()` (#203) — `evaluate()` only echoes
   * this onto `RiskDecision.next_breaker_state`; it never derives or
   * mutates it. The caller persists it to the `breaker_state` table after
   * each call so a restart can reconstruct `CircuitBreakers` exactly.
   */
  next_breaker_state: PersistedBreakerState[];
  /** Pairwise correlation of the intent's instrument vs held instruments (#50); pre-computed by correlation.ts. */
  correlation: CorrelationEstimate;
  /**
   * WorldMonitor CII soft signal (#205), keyed by country/region code.
   * Pre-fetched by `CiiConsumer` (market-intelligence/worldmonitor-adapter/cii-consumer.ts)
   * on its own decoupled cadence, not read live inside `evaluate()`. A country
   * absent from this record has no known score (not zero risk) — see
   * `CiiConsumer.getScores`.
   */
  cii: Record<string, number>;
  /**
   * Red-team critic verdict (#204), pre-fetched by critic.ts (#957).
   *
   * Absent is NOT silently a pass: step 7 records an explicit
   * `risk_critic: skipped` reason (see `RISK_CRITIC_SKIPPED_REASON`), so a
   * decision the critic never saw stays distinguishable from one it passed.
   * The mechanical steps are the safety net either way.
   */
  critic?: RiskCriticVerdict;
  /**
   * Consumed by #77 (`CircuitBreakers.evaluate`), not by this pipeline. It no
   * longer selects manual vs auto re-arm for the hard breaker — since #634 the
   * re-arm policy runs in every mode (ADR-0013) — it now selects only whether
   * `auto_rearm.max_days_tripped`, the elapsed-time arm, is honoured, which is
   * backtest-only.
   */
  mode: 'live' | 'paper' | 'backtest';
}

export interface RiskDecision {
  status: 'approved' | 'rejected';
  /** Possibly trimmed; present iff approved. */
  order_intent: OrderIntent | null;
  modifications: {
    original_size: number;
    final_size: number;
    stop_tightened: boolean;
  } | null;
  /** Which check step trimmed/killed the intent, e.g. 'per_asset_class_cap', 'circuit_breaker:portfolio'. */
  binding_constraint: string | null;
  /** Machine tags + human text (audit). */
  reasons: string[];
  /**
   * Advisory-only tags, e.g. 'macro_risk_flag:RU' from the CII soft signal
   * (#205, ADR-0002). Never trims, rejects, or otherwise affects `status`,
   * `order_intent`, or `binding_constraint` — see "Module: CII Soft Signal".
   */
  warnings: string[];
  risk_snapshot: {
    /** Per instrument / class / portfolio. */
    exposure: Record<string, number>;
    drawdown_pct: number;
    armed_breakers: string[];
  };
  /** Echo of `RiskInput.next_breaker_state` (#203) — the caller persists this to the `breaker_state` table so a restart survives a tripped breaker. */
  next_breaker_state: PersistedBreakerState[];
}

/** Single test seam. Fully deterministic given its inputs. */
export interface RiskManager {
  evaluate(input: RiskInput): RiskDecision;
}
