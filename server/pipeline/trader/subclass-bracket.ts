/**
 * ADR-0018's frozen per-subclass bracket, and the sizing conversion that makes
 * D5's deployment envelope reachable through the Trader's existing formula
 * (#739).
 *
 * Two decisions meet here and they are ONE arithmetic, which is why they are
 * one module rather than two:
 *
 * - **D3 freezes the exit geometry per subclass** — +2.00% / -2.16% on a 3x
 *   index ETP, +6.00% / -6.25% on a 3x single-stock ETP. The stop is a
 *   percentage of entry, not `k x max(ATR, vol_floor)`.
 * - **D5 sizes the position by the measured volatility envelope** — 35% of
 *   equity deployed to a 3x index ETP, 25% to a 3x single-stock ETP.
 *
 * `size = (equity x risk_fraction) / stop_distance` (trader-spec.md "Sizing
 * math") is NOT replaced. Under a frozen percentage stop it collapses:
 * `stop_distance = stop_pct x entry`, so
 *
 * ```
 * size x entry = equity x risk_fraction / stop_pct
 * ```
 *
 * and setting `risk_fraction = deployment_fraction x stop_pct` makes the
 * deployed notional exactly `deployment_fraction x equity`. That collapse is
 * the whole point: D5's envelope is expressed THROUGH the spec's formula, so
 * when the stop later floats (D5's target state, volatility-targeted sizing)
 * nothing has to be un-hardcoded.
 *
 * **#897 (ADR-0018's 2026-09-03 amendment) adds one factor to that conversion
 * and nothing else**: the first tranche is sized at
 * `deployment_fraction x (1 - headroom_reserve_fraction)` so the D5 envelope
 * is drawn on rather than spent, and a later `scale_in` is admissible. The
 * envelope itself — and the Risk Manager's cap that enforces it — is unchanged
 * at 35% / 25%.
 *
 * **`risk_fraction` is DERIVED here, never stored.** ADR-0018's sizing
 * amendment records two silent ways to get the stored form wrong: writing the
 * deployment fraction itself (`0.35` at a 2.16% stop sizes to 16.2x equity),
 * and pairing the single-stock deployment with the INDEX stop
 * (`0.25 x 0.0216 = 0.00540`, which deploys 8.6% instead of 25%, errs small,
 * trips no gate and would survive a full soak). Deriving from the row that
 * carries both numbers makes the second error unconstructible — the stop used
 * for sizing is by construction the stop the bracket is placed at.
 *
 * What derivation does NOT catch is a wrong `stop_pct`, because it cancels out
 * of the deployment identity above. That number is load-bearing on its own —
 * it is the live stop — so it is asserted separately, on the bracket geometry
 * rather than on the deployment (`subclass-bracket.test.ts`).
 */
import type { InstrumentSubclass } from '../../shared/index.js';

/**
 * One subclass's frozen bracket and its deployment envelope.
 *
 * Every field is INJECTED CONFIG rather than a module constant, including the
 * round trip: #666 owns the measured per-subclass spreads and ADR-0018 states
 * plainly that "both brackets and both bars move directly with them, since each
 * cost figure is currently a single quote."
 */
export interface SubclassBracket {
  /**
   * ADR-0018 D3's take-profit, as a fraction of entry. The target leg of the
   * emitted bracket is `entry x (1 +/- take_profit_pct)`.
   */
  take_profit_pct: number;
  /**
   * ADR-0018 D3's stop, as a fraction of entry — the neutral partner of
   * `take_profit_pct` under D3's monotone bijection (+1.0 <-> -1.03,
   * +2.0 <-> -2.16, +3.0 <-> -3.35). Both the live stop and the sizing
   * denominator, which is why one number serves both and why re-deriving it
   * per instrument from that instrument's ATR is the per-instrument threshold
   * fitting D2 refuses.
   */
  stop_pct: number;
  /**
   * ADR-0018 D5's deployment envelope: the fraction of equity this subclass's
   * position commits at full conviction. NOT a `risk_fraction` — see
   * `riskFractionFor`.
   */
  deployment_fraction: number;
  /**
   * ADR-0018 D3's round-trip cost for this subclass, as a fraction of notional
   * (0.18% index, 0.41% single-stock).
   *
   * It does NOT enter sizing or the bracket — D3's percentages are already
   * frozen, and the cost appears only in the accuracy bar (+4.33 pp index,
   * +3.35 pp single-stock) that the debate layer has to clear, which the
   * Trader does not compute. It is carried as config and emitted on the
   * intent's metadata so the expectancy accounting reads the quote the
   * decision was actually made under rather than a constant compiled into a
   * later analysis. #666 may move both figures.
   */
  round_trip_cost_pct: number;
  /**
   * The slice of `deployment_fraction` the FIRST tranche must leave unspent, so
   * a later scale-in into the same subclass is admissible (#897, resolved
   * 2026-09-03).
   *
   * ## Why this exists
   *
   * Before #897, `riskFractionFor` sized a full-conviction entry to land
   * exactly on `deployment_fraction x equity`. The Risk Manager's
   * `per_subclass_deployment_cap` allows total subclass exposure up to the same
   * fraction, so the first fill spent the envelope entirely: every subsequent
   * `scale_in` was trimmed to `allowedAdditional <= 0` and rejected under
   * `min_viable_size`. David ruled that accidental rather than intended — D5 is
   * an envelope, not a per-position-and-done budget — so the first tranche is
   * sized BELOW it and the remainder is what a scale-in draws on.
   *
   * ## Why a uniform multiplier rather than an intent-kind branch
   *
   * `riskFractionFor` never sees whether it is sizing an `entry` or a
   * `scale_in`, and it deliberately still does not. Both are sized at
   * `deployment x stop_pct x (1 - reserve)`; the scale-in is then trimmed by
   * the D5 cap to whatever headroom actually remains. The cap fraction is
   * UNCHANGED at 0.35 / 0.25 — that is what makes the reserved slice reachable,
   * and lowering the cap to match would delete the headroom this field creates.
   *
   * ## Why 0.10, and what it has to survive
   *
   * The reserved slice is `deployment_fraction x reserve x equity`: **3.5% of
   * equity on the index row, 2.5% on the single-stock row** — £35 and £25 at
   * ADR-0015's £1,000 book, against first fills of £315 and £225. It is only a
   * real tranche if it survives three floors:
   *
   * 1. **`min_viable_size` (£10, derived from `min_viable_notional`).** The
   *    Risk Manager tests the TRIMMED notional, so the reserved slice is what
   *    is tested. £35 and £25 clear £10 at the book.
   * 2. **`whole_share_sizing`'s `Math.floor` (#941, on in the shipped
   *    profile).** The slice must buy at least one share, which makes the
   *    reserve a **per-share price ceiling** as well: £35 (index) / £25
   *    (single-stock) at the book. This one is NOT verifiable from the repo —
   *    `lse-etp-pool.ts` carries no prices and mixes GBX and USD lines — so it
   *    is recorded as a boundary rather than claimed to be met.
   * 3. **Live equity, not the £1,000 anchor.** D5 resolves against
   *    `portfolio.equity`, so the reserved slice shrinks with the account. It
   *    drops under the £10 dust floor at **equity £285.71 on the index row
   *    (10 / 0.035)** and **equity £400 on the single-stock row (10 / 0.025)**
   *    — below those, scale-ins are inadmissible again. **The single-stock row
   *    loses admissibility FIRST despite the smaller envelope**, because a
   *    smaller envelope reserves less cash. Recorded rather than engineered
   *    away: both boundaries sit below the drawdown breaker's own trip point
   *    (`max_drawdown_pct: 0.44` fires at £560 against a £1,000 peak), so on a
   *    book funded to the anchor the breaker halts trading before either
   *    boundary is reached.
   *
   * Raising the reserve would lower those boundary equities, but only by
   * deploying less of a measured envelope on the first fill, and nothing except
   * the unverifiable price ceiling in (2) pushes it up. 0.10 is the smaller
   * deviation from D5's measurement, which is the direction ADR-0018 declares a
   * preference for ("errs small").
   *
   * ## What the reserve yields: one scale-in, not a ladder
   *
   * A second scale-in asks for the same `deployment x (1 - reserve)`, is
   * trimmed to the £0 that remains, and is rejected under `min_viable_size`.
   * That is deliberate and is what keeps this consistent with #708's rejection
   * of the tranche ladder: the envelope admits exactly one top-up, not a
   * schedule of them.
   *
   * INJECTED CONFIG like every other field here — it moves when an ADR
   * amendment moves it, not when code is edited.
   */
  headroom_reserve_fraction: number;
}

/**
 * ADR-0018 D5's index-ETP deployment.
 *
 * D5 published this row at 23.1% measured drawdown, i.e. inside CONTEXT.md's
 * ~20-25% tolerance. **It is not inside it any more.** D5's #729 verification
 * note (2026-08-17) re-measures the row at the neutral bracket D3 actually
 * declares and this module implements: **26.2%** at 35% deployment, above the
 * top of the band. The overshoot is small next to the single-stock row's, but
 * it exists, and the constant below carries the full derivation and the reason
 * neither row is re-sized here.
 */
export const D5_INDEX_ETP_DEPLOYMENT_FRACTION = 0.35;

/**
 * ADR-0018 D5's single-stock-ETP deployment, and the overshoot that comes with
 * it — a named constant with its citation rather than a bare `0.25` precisely
 * so the overshoot is consumed knowingly (D5: "it is recorded here rather than
 * rounded off so that whatever consumes this number for sizing consumes the
 * overshoot with it").
 *
 * **The size of the overshoot is NOT D5's published ~1.2 pp.** D5 carries a
 * verification note from #729 (2026-08-17) recording that its envelope table
 * was measured at the pre-neutral `SLS = {1.5, 3}` grid — single-stock TP
 * +6.0% / SL **-3.00%** — and not at the neutral bracket D3 declares and this
 * module implements. Re-measured at the declared -6.25% stop (2.08x the stop
 * that was measured; per-trade sd 4.01% -> 5.36%), the envelope at 25%
 * deployment is **~41.8%**, i.e. roughly **17 pp** above the top of
 * CONTEXT.md's ~20-25% band. The index row moves too: 23.1% -> 26.2% at 35%.
 *
 * **0.25 is still the declared rule, and keeping it is deliberate.** The #729
 * note "records the measurement only — re-sizing, re-opening the stop, or
 * accepting the wider envelope is an amendment not taken here." Holding the
 * tolerance at the declared brackets would need f ~= 0.332 (index) and
 * f ~= 0.142 (single-stock); adopting either here would be an unrecorded
 * amendment, which is exactly what ADR-0018 D4 forbids. Do not tighten this
 * number in code — it moves when an ADR amendment moves it.
 */
export const D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION = 0.25;

/**
 * #897's scale-in headroom reserve, as a fraction of the D5 envelope, for both
 * subclasses.
 *
 * One number on both rows rather than one global constant. The per-subclass
 * granularity is justified by where the field lives and by what it implies —
 * NOT by the two values differing today. Every field on `SubclassBracket` is
 * injected config by this module's stated design, and the same 0.10 applied to
 * two different envelopes yields boundary equities 40% apart (£285.71 index vs
 * £400 single-stock — see `SubclassBracket.headroom_reserve_fraction` for that
 * arithmetic). A module-level constant would make the identical seeding read as
 * a property of the system rather than the coincidence it is. Both rows are
 * seeded at 0.10 because nothing measured distinguishes them.
 */
export const D5_SCALE_IN_HEADROOM_RESERVE_FRACTION = 0.1;

/**
 * ADR-0018 D3 + D5 as config, per subclass.
 *
 * `null` is an ANSWER, not a gap: ADR-0018's Consequences say in as many words
 * that "the crypto brackets are not set by this ADR" (#660's 4%/2% levels are
 * unmeasured), and ADR-0014's 2026-08-16 amendment puts crypto out of Samurai's
 * scope entirely, so no measurement is coming. Total over `InstrumentSubclass`
 * so a new subclass is a compile error here rather than a silent absence —
 * the same totality argument `SubclassDeploymentCap.cap` carries.
 */
export type SubclassBracketTable = Readonly<Record<InstrumentSubclass, SubclassBracket | null>>;

/** ADR-0018 D3's bracket table and D5's envelope, verbatim. */
export const ADR_0018_SUBCLASS_BRACKETS: SubclassBracketTable = {
  index_etp_3x: {
    take_profit_pct: 0.02,
    stop_pct: 0.0216,
    deployment_fraction: D5_INDEX_ETP_DEPLOYMENT_FRACTION,
    round_trip_cost_pct: 0.0018,
    headroom_reserve_fraction: D5_SCALE_IN_HEADROOM_RESERVE_FRACTION,
  },
  single_stock_etp_3x: {
    take_profit_pct: 0.06,
    stop_pct: 0.0625,
    deployment_fraction: D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
    round_trip_cost_pct: 0.0041,
    headroom_reserve_fraction: D5_SCALE_IN_HEADROOM_RESERVE_FRACTION,
  },
  crypto: null,
};

/**
 * ADR-0018's sizing amendment, point 3, less #897's headroom reserve:
 * `risk_fraction = deployment x stop_pct x (1 - headroom_reserve)`, per
 * subclass.
 *
 * The amendment's own table is the `reserve = 0` case — 0.35 x 0.0216 =
 * 0.00756 for the index row, 0.25 x 0.0625 = 0.015625 for the single-stock row.
 * At the reserve ADR-0018's 2026-09-03 amendment declares (0.10 on both rows)
 * this returns **0.006804** and **0.0140625**, which deploy **31.5%** and
 * **22.5%** of equity on the first tranche and leave 3.5% / 2.5% of headroom
 * for a scale-in the D5 cap then trims to fit.
 *
 * Asserting any of those constants is NOT a test of this function: both of the
 * ADR's published error modes also produce a number that matches something in
 * the ADR. The assertion that discriminates is on the resulting deployment
 * (`size x entry ~= 0.35 x (1 - reserve) x equity`), which is what
 * `subclass-bracket.test.ts` asserts.
 *
 * **The reserve belongs here and NOT on `per_subclass_deployment_cap`.** The
 * Risk Manager's cap stays at the full 0.35 / 0.25, which is precisely what
 * makes the reserved slice reachable by a later tranche; applying the reserve
 * to both sides would move the ceiling down with the entry and leave no
 * headroom at all. See `SubclassBracket.headroom_reserve_fraction` for the
 * floors the reserved slice has to clear and the equities below which it
 * stops clearing them.
 */
export function riskFractionFor(bracket: SubclassBracket): number {
  return bracket.deployment_fraction * bracket.stop_pct * (1 - bracket.headroom_reserve_fraction);
}

/**
 * Thrown when the Trader cannot resolve a frozen bracket for the instrument it
 * is about to size (#739).
 *
 * **Fail loud, because the alternative is full deployment.** A default bracket
 * would size an unclassified instrument off numbers measured for a different
 * subclass — the ADR's own "errs small, trips no gate" failure in its other
 * direction — and a silent skip would be indistinguishable in a soak log from a
 * market that gave no setups. This mirrors `PerSubclassCapUnresolvableError` in
 * the Risk Manager, which throws on the same question one stage later, for the
 * same reason, and is contained by the same catch: `tick-loop.ts`'s `worker()`
 * wraps each `runInstrument` call (#507), so the blast radius is exactly this
 * instrument's ENTRIES, every tick, until the pool file is corrected.
 *
 * It cannot block an exit: `resolveSubclassBracket` is called only from
 * `buildBracket` (entry / scale-in), never from the flatten, direction-flip or
 * early-exit paths. Flat-by-close therefore survives a stale pool file, which
 * is the property #670/#706 were filed over.
 */
export class SubclassBracketUnresolvableError extends Error {
  constructor(
    message: string,
    readonly instrument: string,
  ) {
    super(message);
    this.name = 'SubclassBracketUnresolvableError';
  }
}

/**
 * The instrument's frozen bracket, or `null` when the per-subclass regime is
 * not armed at all.
 *
 * **The regime arms off the universe, exactly as the Risk Manager's D5 gate
 * does** (`d5EnvelopeFor`, paper-profile.ts). An EMPTY `subclass_of` means no
 * universe row declares a subclass — the state `DEFAULT_UNIVERSE`,
 * `SMOKE_TEST_UNIVERSE` and every backtest fixture are in, none of which holds
 * a leveraged ETP that ADR-0018 prices — and the caller keeps the pre-ADR-0018
 * geometry for those. A PARTLY populated map arms it, and the unclassified
 * names then throw: a half-populated pool file is a mistake to surface, not one
 * to size around.
 *
 * Two failures throw rather than one, because they are different mistakes: an
 * instrument with no subclass is a pool-file omission, while a subclass whose
 * bracket is `null` (crypto) is an instrument ADR-0018 deliberately prices no
 * bracket for and which therefore must not be entered on this rule at all.
 */
/**
 * Refuses a `headroom_reserve_fraction` outside `[0, 1)` (#897).
 *
 * The failure this guards is quiet, not loud. A percent-vs-fraction typo (`10`
 * for `0.10`) makes `riskFractionFor` negative, which makes `size` negative —
 * finite, so `Number.isFinite` admits it — and `decide.ts`'s
 * `submittableSize * entry < config.min_viable_notional` check then turns EVERY
 * entry in that subclass into `skip('below_min_notional')`. Nothing wrong is
 * submitted; the system simply stops trading the subclass, and the only trace
 * is a skip reason indistinguishable in a soak log from a market that offered
 * no setups. `1` is refused for the same reason with a different sign: it
 * reserves the whole envelope and sizes every entry to exactly zero.
 *
 * That is the same class of silent-wrong-config failure `resolveStoreMode` and
 * `SubclassBracketUnresolvableError` already throw over, so it takes the same
 * posture — throw, naming the field, the offending value and the subclass —
 * rather than clamping to a plausible number and continuing.
 *
 * `0` is valid: it is the pre-#897 behaviour, and a deliberate `0` is how a
 * future amendment would turn the reserve off without deleting the field.
 */
function assertValidHeadroomReserve(
  bracket: SubclassBracket,
  subclass: InstrumentSubclass,
  instrument: string,
): void {
  const reserve = bracket.headroom_reserve_fraction;
  if (!Number.isFinite(reserve) || reserve < 0 || reserve >= 1) {
    throw new SubclassBracketUnresolvableError(
      `${instrument} is classified '${subclass}', whose bracket declares ` +
        `headroom_reserve_fraction = ${String(reserve)} — outside [0, 1). ` +
        `It is a FRACTION of the D5 envelope, not a percentage — 10% is 0.1, not ` +
        `10. Outside that range riskFractionFor goes negative or to zero, and every entry in this ` +
        `subclass is silently skipped as below_min_notional rather than refused visibly.`,
      instrument,
    );
  }
}

export function resolveSubclassBracket(
  instrument: string,
  subclassOf: Readonly<Record<string, InstrumentSubclass>>,
  brackets: SubclassBracketTable,
): SubclassBracket | null {
  if (Object.keys(subclassOf).length === 0) return null;

  const subclass = subclassOf[instrument];
  if (subclass === undefined) {
    throw new SubclassBracketUnresolvableError(
      `subclass_of is populated but ${instrument} has no subclass ` +
        `(known: ${Object.keys(subclassOf).join(', ')}). ADR-0018 D3's frozen bracket and D5's ` +
        `deployment envelope cannot be resolved without one, and the alternative to this throw ` +
        `is sizing the position on another subclass's numbers. Add the instrument to the pool file.`,
      instrument,
    );
  }

  const bracket: SubclassBracket | null | undefined = brackets[subclass];
  if (bracket === undefined || bracket === null) {
    throw new SubclassBracketUnresolvableError(
      `${instrument} is classified '${subclass}', for which no frozen bracket is declared. ` +
        `ADR-0018 sets brackets for the two leveraged-ETP subclasses only — crypto's are ` +
        `explicitly not set by it, and crypto is out of scope (ADR-0014's 2026-08-16 ` +
        `amendment) — so there is no measured geometry to enter this instrument on.`,
      instrument,
    );
  }

  assertValidHeadroomReserve(bracket, subclass, instrument);

  return bracket;
}
