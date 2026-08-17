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
}

/**
 * ADR-0018 D5's index-ETP deployment. Sits INSIDE CONTEXT.md's ~20-25% max
 * drawdown tolerance as originally published (23.1%); see the single-stock
 * constant below for what the #729 verification note does to both rows.
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
  },
  single_stock_etp_3x: {
    take_profit_pct: 0.06,
    stop_pct: 0.0625,
    deployment_fraction: D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
    round_trip_cost_pct: 0.0041,
  },
  crypto: null,
};

/**
 * ADR-0018's sizing amendment, point 3: `risk_fraction = deployment x stop_pct`,
 * per subclass.
 *
 * Reproduces the amendment's own table — 0.35 x 0.0216 = **0.00756** for the
 * index row, 0.25 x 0.0625 = **0.015625** for the single-stock row. Asserting
 * those constants is NOT a test of this function: both published error modes
 * also produce a number that matches something in the ADR. The assertion that
 * discriminates is on the resulting deployment (`size x entry ~= 0.35 x equity`),
 * which is what `subclass-bracket.test.ts` asserts.
 */
export function riskFractionFor(bracket: SubclassBracket): number {
  return bracket.deployment_fraction * bracket.stop_pct;
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

  return bracket;
}
