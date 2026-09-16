/**
 * ADR-0018's frozen per-subclass bracket (D3) and D5's deployment envelope,
 * expressed through the Trader's `size = (equity x risk_fraction) /
 * stop_distance` formula: under a frozen percentage stop, setting
 * `risk_fraction = deployment_fraction x stop_pct` makes the deployed
 * notional exactly `deployment_fraction x equity` — so nothing has to
 * change when the stop later floats.
 *
 * `risk_fraction` is DERIVED here, never stored, because pairing the wrong
 * subclass's stop with its own deployment produces a small, gate-passing
 * error that a stored value can't catch. `stop_pct` cancels out of that
 * identity, so it's asserted separately on the bracket geometry (see
 * `subclass-bracket.test.ts`).
 */
import type { InstrumentSubclass } from '../../shared/index.js';

/**
 * One subclass's frozen bracket and its deployment envelope. Every field is
 * INJECTED CONFIG rather than a module constant, including the round-trip
 * cost, which is still a single unmeasured quote (ADR-0016 known
 * weakness).
 */
export interface SubclassBracket {
  /**
   * ADR-0018 D3's take-profit, as a fraction of entry. The target leg of the
   * emitted bracket is `entry x (1 +/- take_profit_pct)`.
   */
  take_profit_pct: number;
  /**
   * ADR-0018 D3's stop, as a fraction of entry — the neutral partner of
   * `take_profit_pct` under D3's monotone bijection. Serves as both the
   * live stop and the sizing denominator; re-deriving it per instrument
   * from ATR is the per-instrument threshold fitting D2 refuses.
   */
  stop_pct: number;
  /**
   * ADR-0018 D5's deployment envelope: the fraction of equity this subclass's
   * position commits at full conviction. NOT a `risk_fraction` — see
   * `riskFractionFor`.
   */
  deployment_fraction: number;
  /**
   * ADR-0018 D3's round-trip cost for this subclass, as a fraction of
   * notional. Does NOT enter sizing or the bracket — D3's percentages are
   * already frozen. Carried as config and emitted on the intent's metadata
   * so expectancy accounting reads the quote the decision was actually
   * made under, not a constant compiled into a later analysis.
   */
  round_trip_cost_pct: number;
  /**
   * The slice of `deployment_fraction` the first tranche must leave
   * unspent so a later scale-in is admissible. Without it, a
   * full-conviction first fill exactly saturates
   * `per_subclass_deployment_cap`, so every scale-in trims to zero and is
   * rejected under `min_viable_size`. Applied uniformly to `entry` and
   * `scale_in` sizing; the cap itself stays at the full 0.35/0.25, which
   * is what makes the reserved slice reachable — lowering it to match
   * would delete the headroom this field creates.
   *
   * 0.10 is deliberate ("errs small" per ADR-0018): the reserved slice
   * (3.5%/2.5% of equity) drops under the £10 min-viable-size floor at
   * equity £285.71 (index) / £400 (single-stock), below which a scale-in
   * is inadmissible again — both sit below the drawdown breaker's own
   * trip point. Yields exactly one scale-in, not a ladder (#708 rejected
   * the tranche ladder).
   *
   * INJECTED CONFIG like every other field here — it moves when an ADR
   * amendment moves it, not when code is edited.
   */
  headroom_reserve_fraction: number;
}

/**
 * ADR-0018 D5's index-ETP deployment. Published at 23.1% measured
 * drawdown (inside CONTEXT.md's ~20-25% tolerance), but re-measured
 * against the neutral bracket D3 actually declares, it is 26.2% — above
 * the top of the band. Not re-sized here; see
 * `D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION` for why.
 */
export const D5_INDEX_ETP_DEPLOYMENT_FRACTION = 0.35;

/**
 * ADR-0018 D5's single-stock-ETP deployment — a named constant with its
 * citation rather than a bare `0.25` so the overshoot is consumed
 * knowingly. D5's published ~1.2pp overshoot was measured at the
 * pre-neutral stop; re-measured at the declared -6.25% stop, the envelope
 * is ~41.8%, ~17pp above CONTEXT.md's ~20-25% tolerance band.
 *
 * 0.25 is still the declared rule — tightening it here would be an
 * unrecorded amendment, which ADR-0018 D4 forbids. It moves only when an
 * ADR amendment moves it.
 */
export const D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION = 0.25;

/**
 * Scale-in headroom reserve, as a fraction of the D5 envelope, for both
 * subclasses. One number, not a per-subclass constant, purely because
 * nothing measured distinguishes them yet — see
 * `SubclassBracket.headroom_reserve_fraction` for how the same 0.10
 * resolves to different boundary equities per row.
 */
export const D5_SCALE_IN_HEADROOM_RESERVE_FRACTION = 0.1;

/**
 * ADR-0018 D3 + D5 as config, per subclass. `null` is an ANSWER, not a
 * gap — ADR-0018 states crypto's brackets are not set by it, and crypto
 * is out of Samurai's scope entirely, so no measurement is coming. Total
 * over `InstrumentSubclass` so a new subclass is a compile error here
 * rather than a silent absence.
 */
export type SubclassBracketTable = Readonly<Record<InstrumentSubclass, SubclassBracket | null>>;

/** ADR-0018 D3's bracket table and D5's envelope, verbatim */
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
 * ADR-0018's sizing amendment less the headroom reserve:
 * `risk_fraction = deployment x stop_pct x (1 - headroom_reserve)`.
 * Asserting the resulting constant is not a sufficient test — both of the
 * ADR's published error modes also produce a number matching something in
 * the ADR — so `subclass-bracket.test.ts` asserts the resulting deployment
 * instead.
 *
 * The reserve belongs here, not on `per_subclass_deployment_cap`: the cap
 * stays at the full 0.35/0.25, which is what makes the reserved slice
 * reachable by a later tranche. Applying it to both sides would move the
 * ceiling down with the entry and leave no headroom at all.
 */
export function riskFractionFor(bracket: SubclassBracket): number {
  return bracket.deployment_fraction * bracket.stop_pct * (1 - bracket.headroom_reserve_fraction);
}

/**
 * Thrown when the Trader cannot resolve a frozen bracket for the
 * instrument it is about to size. Fail loud, because the alternative is
 * full deployment: a default bracket would size an unclassified
 * instrument off numbers measured for a different subclass, and a silent
 * skip would be indistinguishable in a soak log from a market with no
 * setups. Mirrors `PerSubclassCapUnresolvableError` in the Risk Manager.
 *
 * Cannot block an exit — only called from `buildBracket` (entry/scale-in),
 * never flatten/flip/early-exit — so flat-by-close survives a stale pool
 * file.
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
 * The instrument's frozen bracket, or `null` when the per-subclass regime
 * is not armed — arms off the universe, exactly as the Risk Manager's D5
 * gate does. An empty `subclass_of` means no universe row declares a
 * subclass, so the caller keeps pre-ADR-0018 geometry; a partly populated
 * map arms it, and unclassified names then throw — a half-populated pool
 * file is a mistake to surface, not one to size around.
 */
/**
 * Refuses a `headroom_reserve_fraction` outside `[0, 1)`. The failure this
 * guards is quiet, not loud: a percent-vs-fraction typo (`10` for `0.10`)
 * makes `riskFractionFor` negative, which then turns every entry in that
 * subclass into `skip('below_min_notional')` — a trace indistinguishable
 * in a soak log from a market with no setups. `1` is refused for the same
 * reason (sizes every entry to zero); `0` is valid and is how a future
 * amendment would turn the reserve off without deleting the field.
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
