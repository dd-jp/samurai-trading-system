/**
 * Risk Manager (Stage 4) — core check pipeline (ticket #76).
 * See docs/specs/risk-manager-spec.md (Module: Check Pipeline).
 *
 * Ordered, monotonic risk-reducing gate: breakers -> per-trade -> per-asset
 * -> per-asset-class -> portfolio -> concentration -> min-size. Every step
 * trims notional exposure or hard-rejects; nothing ever increases size or
 * loosens a stop. Exits skip every entry gate and pass through verbatim.
 *
 * `PortfolioView` (#78), `BreakerState` (#77), and `CorrelationEstimate`
 * (#50, correlation.ts) are consumed as pre-built inputs — this pipeline
 * does not compute exposure, drawdown, breaker trips, or correlations
 * itself.
 *
 * The CII soft signal (#205, ADR-0002) runs alongside this pipeline as a
 * purely advisory check — it reads `RiskInput.cii` (pre-fetched by
 * `CiiConsumer`, market-intelligence/worldmonitor-adapter/cii-consumer.ts)
 * and appends to `RiskDecision.warnings`, but never participates in trimming
 * or rejecting.
 */
import { countryForInstrument } from './cii-mapping.js';
import { type RiskThresholdSource, resolveRiskConfig } from './risk-thresholds.js';
import type {
  BreakerState,
  PortfolioView,
  RiskConfig,
  RiskCriticVerdict,
  RiskDecision,
  RiskInput,
  RiskManager,
} from './types.js';

export type {
  AutoReArmPolicy,
  BreakerConfig,
  BreakerEvalInput,
  VolatilityBreakerConfig,
  VolatilityReading,
} from './breakers.js';
export { CircuitBreakers } from './breakers.js';
export { countryForInstrument, trackedCountries } from './cii-mapping.js';
export type { CorrelationConfig, CorrelationEstimateInput } from './correlation.js';
export { computeCorrelationEstimate } from './correlation.js';
export type { PortfolioAccountingInput } from './portfolio-view.js';
export { computePortfolioView } from './portfolio-view.js';
export {
  RISK_THRESHOLD_KEYS,
  type RiskThresholdKey,
  type RiskThresholdSource,
  resolveRiskConfig,
  riskThresholdsFrom,
} from './risk-thresholds.js';
export type { BreakerStatePersistence } from './sqlite-breaker-state-store.js';
export { SqliteBreakerStateStore } from './sqlite-breaker-state-store.js';
export type {
  BreakerState,
  CorrelationEstimate,
  DailyPnl,
  DailyPnlByClass,
  PersistedBreakerState,
  PortfolioView,
  RiskConfig,
  RiskCriticLog,
  RiskCriticStore,
  RiskCriticVerdict,
  RiskDecision,
  RiskInput,
  RiskManager,
  SessionBasis,
  SessionBasisByClass,
  SubclassDeploymentCap,
} from './types.js';

/**
 * `RiskInput.next_breaker_state` (#203) is only ever echoed onto
 * `RiskDecision.next_breaker_state` below — `evaluate()` stays pure and
 * never computes or mutates breaker state itself. The caller (whoever
 * called `CircuitBreakers.getPersistedState()` to build this input)
 * persists the echoed value to the `breaker_state` table after each call.
 */

/**
 * CII soft signal (#205, ADR-0002): runs alongside the check pipeline, not
 * as one of its ordered steps — purely advisory, never consulted by any trim
 * or reject decision above. Fires on the country's absolute CII level (not
 * delta), so a sustained high-risk exposure warns every cycle it's
 * evaluated. An unmapped instrument or a country with no cached score
 * produces no warning.
 */
function ciiWarnings(instrument: string, cii: Record<string, number>, threshold: number): string[] {
  const country = countryForInstrument(instrument);
  if (country === null) {
    return [];
  }
  const score = cii[country];
  if (score === undefined || score <= threshold) {
    return [];
  }
  return [`macro_risk_flag:${country}`];
}

/**
 * Correlation warm-up warning (#303). Step 6 treats an instrument absent from
 * `correlation.correlations` as not correlated — the warm-up fallback
 * documented in risk-manager-spec.md, "Module: Correlation Warm-up
 * Visibility". That is unchanged here: this produces advisory tags only and
 * is never consulted by a trim or a reject.
 *
 * What it fixes is the conflation. An empty `correlations` map is produced
 * both by a portfolio of genuinely independent holdings and by a portfolio
 * with no overlapping history at all — the day-1-of-a-soak case, where the
 * concentration cap is silently inert precisely while the first positions go
 * on. `insufficient_history` names the second case so the decision states it.
 */
function correlationWarmupWarnings(insufficientHistory: string[]): string[] {
  return insufficientHistory.map((instrument) => `correlation_warmup:${instrument}`);
}

function snapshot(portfolio: PortfolioView, breakers: BreakerState): RiskDecision['risk_snapshot'] {
  return {
    exposure: {
      ...portfolio.exposure_by_instrument,
      crypto: portfolio.exposure_by_class.crypto,
      stocks: portfolio.exposure_by_class.stocks,
      portfolio: portfolio.gross_exposure,
    },
    drawdown_pct: portfolio.drawdown_pct,
    armed_breakers: breakers.armed_breakers,
  };
}

/** Trims `currentNotional` down to `allowedAdditional` (floored at 0) if it exceeds it. Never increases. */
function trimToAllowed(
  currentNotional: number,
  allowedAdditional: number,
  name: string,
  reasons: string[],
): { notional: number; changed: boolean } {
  const cap = Math.max(allowedAdditional, 0);
  if (currentNotional <= cap) {
    return { notional: currentNotional, changed: false };
  }
  reasons.push(
    `${name}: trimmed notional from ${currentNotional} to ${cap} (exceeded allowed exposure)`,
  );
  return { notional: cap, changed: true };
}

export class RiskManagerImpl implements RiskManager {
  /**
   * `thresholds` is the live `risk_thresholds` table (#433). Optional, because
   * a backtest or a unit test has no store and the static config is the whole
   * truth there — but on the production path it is supplied, and without it
   * `autoTighten`'s defensive response to a kill-line breach changes no
   * decision at all (feedback-loop-spec.md "Module: Guardrailed Tuning").
   */
  constructor(
    private readonly config: RiskConfig,
    private readonly thresholds?: RiskThresholdSource,
  ) {}

  /**
   * The check pipeline: exit pass-through, then the circuit-breaker gate,
   * then `ENTRY_CAP_GATES` in declared order, then the min-viable re-check
   * and the critic review. The ordering IS the spec's step numbering — each
   * gate's own doc says what it caps.
   */
  evaluate(input: RiskInput): RiskDecision {
    const { intent, portfolio, breakers, correlation, cii, critic, next_breaker_state } = input;

    // Resolved per call, not per construction. That is the entire point of the
    // ticket: a threshold the Feedback Loop tightened between two ticks has to
    // bind on the second one, and a config frozen in the constructor cannot.
    //
    // SKIPPED for an exit intent (#766). `resolveRiskConfig` re-checks the
    // WHOLE `risk_thresholds` row set against the in-code clamp
    // (threshold-bounds.ts) on every call and THROWS on a crossing — that is
    // the point of the clamp, but until this fix the throw was raised ahead
    // of the `intent_type === 'exit'` branch below, so an out-of-bound row
    // aborted an exit intent exactly like an entry one. An exit bypasses
    // every entry gate and consults `config` nowhere in the branch below —
    // `cii_threshold` is the one field the exit's `warnings` calculation
    // reads, and it is deliberately excluded from `RISK_THRESHOLD_KEYS`
    // (risk-thresholds.ts: "drives a WARNING, not a limit"), so
    // `resolveRiskConfig` never changes it — `config.cii_threshold` is
    // byte-identical whether or not the live table is consulted. Skipping the
    // resolve therefore changes NOTHING about what an exit decides; it only
    // removes exits' exposure to a corrupt threshold row they never needed.
    // ADR-0014's flat-by-close flatten rides the exit path, and a bad
    // threshold row stranding open positions through the close would be a
    // materially worse defect than the audibility gap #766 was filed for.
    const { config } =
      intent.intent_type === 'exit' || !this.thresholds
        ? { config: this.config }
        : resolveRiskConfig(this.config, this.thresholds.getRiskThresholds());

    const warnings = [
      ...ciiWarnings(intent.instrument, cii, config.cii_threshold),
      ...correlationWarmupWarnings(correlation.insufficient_history),
    ];
    const decisionBase = {
      warnings,
      risk_snapshot: snapshot(portfolio, breakers),
      next_breaker_state,
    };
    const rejected = (binding_constraint: string, reasons: string[]): RiskDecision => ({
      status: 'rejected',
      order_intent: null,
      modifications: null,
      binding_constraint,
      reasons,
      ...decisionBase,
    });

    if (intent.intent_type === 'exit') {
      return {
        status: 'approved',
        order_intent: intent,
        modifications: {
          original_size: intent.size,
          final_size: intent.size,
          stop_tightened: false,
        },
        binding_constraint: null,
        reasons: ['exit: bypasses all entry gates, passes through verbatim'],
        ...decisionBase,
      };
    }

    // #841: an entry may not be sized against a book that was only partly
    // valued. `computePortfolioView` normally refuses to produce such a view
    // at all, and on the entry path it still does — but the exit path now
    // takes a degraded one deliberately (`unvaluable_marks: 'exclude'`), so
    // "no degraded view can exist" stopped being a property of the type and
    // became a property of one call site in the composition root. This is the
    // guard that puts it back in the gate: every cap below reads an absent
    // instrument as ZERO exposure, so a book missing a position is a book
    // whose per-asset, per-subclass and gross caps are all too wide.
    //
    // Placed BELOW the exit branch on purpose — an exit is what the degraded
    // view exists to let through, and it consults none of these caps.
    if (portfolio.unvalued_instruments.length > 0) {
      const binding = 'unvalued_book';
      return rejected(binding, [
        `${binding}: ${portfolio.unvalued_instruments.length} held instrument(s) could not be ` +
          `valued (${portfolio.unvalued_instruments.join(', ')}), so every exposure cap below ` +
          'would read them as zero exposure and allow a larger entry than the book supports. ' +
          'Exits are unaffected (they return above this line).',
      ]);
    }

    const trippedTier = trippedBreakerTier(breakers, intent.asset_class);
    if (trippedTier !== null) {
      const binding = `circuit_breaker:${trippedTier}`;
      return rejected(binding, [
        `${binding}: new entries halted (armed: ${
          breakers.armed_breakers.length > 0 ? breakers.armed_breakers.join(', ') : 'none'
        })`,
      ]);
    }

    const reasons: string[] = [];
    let bindingConstraint: string | null = null;
    let notional = intent.size * intent.entry;

    for (const gate of ENTRY_CAP_GATES) {
      const cap = gate(config, intent, portfolio, correlation);
      if (cap === null) continue;
      const { notional: trimmed, changed } = trimToAllowed(
        notional,
        cap.allowedAdditional,
        cap.name,
        reasons,
      );
      notional = trimmed;
      if (changed) bindingConstraint = cap.name;
    }

    const finalSize = notional / intent.entry;

    if (notional < config.min_viable_size) {
      reasons.push(
        `min_viable_size: trimmed notional ${notional} below viable minimum ${config.min_viable_size}`,
      );
      return rejected('min_viable_size', reasons);
    }

    // Risk-critic review (#204).
    if (critic === undefined) {
      // Fails open BY RECORD, not silently (review 2026-08-06 B3): no producer
      // for the critic exists yet, and until one does, every decision must be
      // distinguishable from one the critic actually passed. The mechanical
      // steps above remain the safety net.
      reasons.push('risk_critic: skipped — no critic verdict was supplied for this evaluation');
    }
    if (critic) {
      const criticTrim = applyCritic(critic, notional, finalSize, reasons);
      if (criticTrim.rejected) {
        return rejected('risk_critic:reject', reasons);
      }
      if (criticTrim.changed) {
        notional = criticTrim.notional;
        bindingConstraint = 'risk_critic:trim';
      }
    }

    return {
      status: 'approved',
      order_intent: { ...intent, size: notional / intent.entry },
      modifications: {
        original_size: intent.size,
        final_size: notional / intent.entry,
        stop_tightened: false,
      },
      binding_constraint: bindingConstraint,
      reasons,
      ...decisionBase,
    };
  }
}

/**
 * Thrown by `perSubclassDeploymentCap` (#726) when the gate cannot resolve an
 * envelope for the intent's own instrument — no subclass recorded for it, or a
 * subclass recorded with no cap declared for it. Carries `bindingConstraint`
 * pre-formatted so the catch in `direct-bind.ts`'s `buildRiskStep` can write
 * the `risk_log` row this throw would otherwise leave absent (see that gate's
 * doc comment for why the throw itself is not softened) without re-parsing
 * the message or re-deriving which subclass was the problem.
 */
export class PerSubclassCapUnresolvableError extends Error {
  constructor(
    message: string,
    readonly instrument: string,
    readonly bindingConstraint: string,
  ) {
    super(message);
    this.name = 'PerSubclassCapUnresolvableError';
  }
}

/** The circuit-breaker gate — halts new entries + scale-ins, fail fast. */
function trippedBreakerTier(
  breakers: BreakerState,
  assetClass: RiskInput['intent']['asset_class'],
): string | null {
  if (breakers.portfolio_tripped) return 'portfolio';
  if (breakers.asset_class_tripped[assetClass]) return assetClass;
  return null;
}

/**
 * One entry cap: how much ADDITIONAL notional this gate allows, under its
 * binding-constraint name — or `null` when the gate does not apply to this
 * intent. Evaluated in `ENTRY_CAP_GATES` order; monotonic risk-reducing by
 * construction, since `trimToAllowed` only ever trims.
 */
type EntryCapGate = (
  config: RiskConfig,
  intent: RiskInput['intent'],
  portfolio: PortfolioView,
  correlation: RiskInput['correlation'],
) => { name: string; allowedAdditional: number } | null;

/**
 * Whether D5 is ARMED for this instrument with a NUMERIC fraction — the
 * predicate `perTradeSizeCap` and `perSubclassDeploymentCap` must agree on
 * (#886), so it lives once, here, rather than each gate re-deriving "is this
 * instrument classified" and drifting on what that means.
 *
 * Deliberately NOT "has a `subclass_of` entry": a subclass with a `null`
 * fraction (crypto, today — doc 18 covers only the two leveraged-ETP
 * subclasses) means D5 measured no envelope at all, so exempting
 * `per_trade_size_cap` there would leave the instrument with NO per-trade
 * bound whatsoever — strictly looser than today, and not what #886 ruled.
 * An instrument absent from `subclass_of` (undefined) is likewise not
 * exempt: `perSubclassDeploymentCap` throws on it, so keeping the generic
 * cap is fail-closed either way.
 */
function isD5ArmedWithNumericFraction(
  config: RiskConfig,
  instrument: RiskInput['intent']['instrument'],
): boolean {
  const declared = config.per_subclass_deployment_cap;
  if (declared === undefined) return false;
  const subclass = declared.subclass_of[instrument];
  if (subclass === undefined) return false;
  return typeof declared.cap_fraction_of_equity[subclass] === 'number';
}

/**
 * #886: David's ruling on the anchor-vs-equity mismatch this gate used to
 * have with D5 (`server/pipeline/risk-manager/index.ts:513`) — "D5's own
 * fraction … is the sole drawdown authority once an instrument is
 * subclass-classified. `per_trade_size_cap` becomes the cap for unclassified
 * instruments only." A D5-classified instrument with a numeric fraction
 * therefore skips this gate entirely (`null`) rather than being trimmed to
 * whichever of the two caps is smaller.
 */
const perTradeSizeCap: EntryCapGate = (config, intent, portfolio) => {
  if (isD5ArmedWithNumericFraction(config, intent.instrument)) return null;
  return {
    name: 'per_trade_size_cap',
    allowedAdditional: config.max_position_size_fraction_of_equity * portfolio.equity,
  };
};

const perAssetExposureCap: EntryCapGate = (config, intent, portfolio) => ({
  name: 'per_asset_exposure_cap',
  allowedAdditional:
    config.per_asset_cap_fraction_of_equity * portfolio.equity -
    (portfolio.exposure_by_instrument[intent.instrument] ?? 0),
});

const perAssetClassExposureCap: EntryCapGate = (config, intent, portfolio) => ({
  name: 'per_asset_class_exposure_cap',
  allowedAdditional:
    config.per_asset_class_cap_fraction_of_equity[intent.asset_class] * portfolio.equity -
    portfolio.exposure_by_class[intent.asset_class],
});

const portfolioGrossExposureCap: EntryCapGate = (config, _intent, portfolio) => ({
  name: 'portfolio_gross_exposure_cap',
  allowedAdditional:
    config.portfolio_gross_cap_fraction_of_equity * portfolio.equity - portfolio.gross_exposure,
});

/**
 * Concentration check (v2 dynamic correlation matrix, #50). Instruments
 * absent from `correlation.correlations` are treated as not correlated —
 * that's the warm-up fallback, not a special case here. #303 deliberately
 * did NOT change that: an under-`min_bars` pair still cannot bind this cap.
 * It is surfaced as a `correlation_warmup:` warning instead, so the
 * inertness is stated rather than inferred from silence.
 */
const concentrationCorrelationCap: EntryCapGate = (config, intent, portfolio, correlation) => {
  const correlatedInstruments = Object.entries(correlation.correlations)
    .filter(([, corr]) => Math.abs(corr) >= config.concentration.threshold)
    .map(([instrument]) => instrument);
  if (correlatedInstruments.length === 0) return null;

  const correlatedSet = [intent.instrument, ...correlatedInstruments];
  const existingCorrelatedExposure = correlatedSet.reduce(
    (sum, instrument) => sum + (portfolio.exposure_by_instrument[instrument] ?? 0),
    0,
  );
  return {
    name: 'concentration_correlation_cap',
    allowedAdditional:
      config.concentration.cap_fraction_of_equity * portfolio.equity - existingCorrelatedExposure,
  };
};

/**
 * ADR-0018 D5's deployment envelope (#703, step A6) — max notional across
 * every instrument of the intent's subclass.
 *
 * **Netted across the subclass, not per position.** The tempting form is
 * `allowedAdditional: cap`, matching `perTradeSizeCap`, and it is wrong twice
 * over: `buildBracket` sizes a `scale_in` exactly like an entry precisely
 * because "Risk enforces the exposure cap downstream" (trader/decide.ts), so a
 * non-netted cap admits entry-at-35% then scale-in-at-35%; and two different
 * 3x index ETPs held at once would each get the full envelope. Either voids
 * the 23.1% drawdown figure the fraction was measured to hold. D5's envelope
 * is "35% of the leg deployed to 3x index ETPs", so the sum is what binds.
 *
 * Instruments absent from `subclass_of` are skipped by the netting filter
 * (`undefined !== subclass`) rather than throwing — a legacy or manually-held
 * position should not be able to break sizing for an unrelated name. Only the
 * INTENT's own instrument must be classified, and that one throws.
 *
 * **What the throw can and cannot reach, since it fires on the live decision
 * path.** `evaluate()` returns at `intent.intent_type === 'exit'` BEFORE the
 * `ENTRY_CAP_GATES` loop is entered, so no throw in any gate — this one
 * included — can block an exit. Flat-by-close therefore cannot be stopped by a
 * stale pool file, which matters because a flatten that silently stops running
 * is the defect class #670/#706 were filed for. The blast radius is exactly:
 * one unclassified instrument's ENTRIES refuse, every tick, until the pool file
 * is corrected. That refusal is the intended reading of a half-populated pool
 * file, and it is strictly safer than the alternative of entering unbounded.
 *
 * **That "one instrument" bound is a claim about a caller, so here is the
 * caller.** `SequentialTickRunner.runInstrument` deliberately has no try/catch;
 * the containment is one level up, in `tick-loop.ts`'s `worker()`, which wraps
 * each `runInstrument` call in its own try/catch (#507) precisely so one
 * instrument throwing cannot reject the worker's `Promise.all` entry and settle
 * the whole tick while sibling instruments are still mid-pipeline. The throw
 * becomes a logged `TickOutcome.error` and a durable `audit_log` row for that
 * instrument alone. Without #507's catch this throw WOULD take down the tick
 * for every instrument, so if that catch is ever removed, this gate must be
 * revisited with it — the two are coupled, and only this comment says so.
 *
 * **What the throw cost, and #726's fix.** This is the only entry gate that
 * throws rather than returning a decision, and `riskLog.write` in
 * `production/direct-bind.ts` runs only AFTER `evaluate()` returns normally —
 * so on its own a refused instrument would write **no `risk_log` row**. #726
 * closed that: `buildRiskStep` wraps the `evaluate()` call in a try/catch and,
 * on a `PerSubclassCapUnresolvableError`, writes a `risk_log` row with
 * `status: 'error'` and `binding_constraint` set from the error's own
 * `bindingConstraint` (naming the unclassified instrument or subclass) BEFORE
 * re-throwing — the throw itself is untouched and still propagates to #507's
 * catch in `tick-loop.ts` for the `audit_log` row and the log line. The row is
 * additive, not a substitute: #507's catch still runs unchanged.
 *
 * Returning a rejected decision instead WOULD have closed the original gap
 * too, and that was rejected deliberately: a rejection is quiet, and a
 * half-populated pool file that merely declines entries can run for days
 * looking like a market with no setups. The throw is chosen for being
 * impossible to ignore — #726 made the audit gap it left behind not free, not
 * the throw itself.
 */
const perSubclassDeploymentCap: EntryCapGate = (config, intent, portfolio) => {
  const declared = config.per_subclass_deployment_cap;
  if (declared === undefined) return null;

  const subclass = declared.subclass_of[intent.instrument];
  if (subclass === undefined) {
    throw new PerSubclassCapUnresolvableError(
      `per_subclass_deployment_cap is declared but ${intent.instrument} has no subclass ` +
        `(known: ${Object.keys(declared.subclass_of).join(', ') || 'none'}). ADR-0018 D5's ` +
        `deployment envelope cannot be resolved without one, and the alternative to this throw ` +
        `is sizing the position with no envelope at all. Add the instrument to the pool file.`,
      intent.instrument,
      `per_subclass_deployment_cap:unclassified_instrument:${intent.instrument}`,
    );
  }

  // `cap` is total over `InstrumentSubclass` at COMPILE time only. `subclass_of`
  // is built from the pool file at the composition root, so a subclass string
  // that reaches here without a row in `cap` is a runtime possibility the type
  // cannot exclude — and `undefined` is the one value that must not fall
  // through. `undefined - deployedToSubclass` is `NaN`, `trimToAllowed` does
  // `Math.max(NaN, 0) === NaN`, `notional <= NaN` is false so it "trims" to
  // `NaN`, and `NaN < config.min_viable_size` is false too — so the intent
  // clears both this gate and the min-viable floor with no envelope at all.
  // That is the exact failure D5 exists to prevent, arriving silently.
  const capFraction: number | null | undefined = declared.cap_fraction_of_equity[subclass];
  if (capFraction === undefined) {
    throw new PerSubclassCapUnresolvableError(
      `per_subclass_deployment_cap declares ${intent.instrument} as '${subclass}' but carries no ` +
        `cap for that subclass (known: ` +
        `${Object.keys(declared.cap_fraction_of_equity).join(', ') || 'none'}). ADR-0018 ` +
        `D5's envelope cannot be resolved without one, and the alternative to this throw is sizing ` +
        `the position with no envelope at all. Add the subclass to the cap record.`,
      intent.instrument,
      `per_subclass_deployment_cap:no_cap_for_subclass:${subclass}`,
    );
  }
  if (capFraction === null) return null;

  // #888 — the equity this fraction resolves against is the DECLARED BOOK
  // (`equity_ceiling.book`), not raw `portfolio.equity`, once the two
  // diverge. `portfolio.equity` is one blended broker figure with no
  // per-leg accounting, so it equals the book only by coincidence of how the
  // account happens to be funded at this instant; funding it past the book
  // must not silently widen every position the same fractions size.
  const ceiling = declared.equity_ceiling;
  if (ceiling !== undefined) {
    const refuseAbove = ceiling.book * (1 + ceiling.refuse_above_tolerance);
    if (portfolio.equity > refuseAbove) {
      // The backstop half of the fix: an account funded THIS far past the
      // declared book does not merely make this one cap too generous — it
      // invalidates the other assumptions the book was sized against too
      // (the breaker baselines, the drawdown envelope D5's fractions were
      // measured to hold). Refusing the entry outright, rather than quietly
      // capping and moving on, is what turns that into something the
      // operator has to notice and correct, per #888's chosen resolution.
      throw new PerSubclassCapUnresolvableError(
        `per_subclass_deployment_cap's declared book is ${ceiling.book} but portfolio.equity is ` +
          `${portfolio.equity}, more than ${(ceiling.refuse_above_tolerance * 100).toFixed(0)}% ` +
          `above it. ADR-0018 D5's envelope was measured against the declared book (#888), and an ` +
          'account funded this far past it invalidates every sizing assumption built on that ' +
          'book, not just this one fraction. Refusing to size this entry — re-fund the account ' +
          'down to the declared book, or raise the book deliberately.',
        intent.instrument,
        `per_subclass_deployment_cap:equity_exceeds_book:${intent.instrument}`,
      );
    }
  }

  // Resolved against the equity read of THIS decision (#739), which is the
  // whole point of the fractional form: a frozen cash cap is a rising fraction
  // of a falling book, so it stops bounding drawdown at the first loss. Below
  // the declared book (or when no book is declared at all) that equity read
  // is `portfolio.equity` unclamped; at or above the book (within tolerance)
  // it is clamped to the book, per #888 — the whole point of `equity_ceiling`.
  const cappedEquity =
    ceiling === undefined ? portfolio.equity : Math.min(portfolio.equity, ceiling.book);
  const cap = capFraction * cappedEquity;

  const deployedToSubclass = Object.entries(portfolio.exposure_by_instrument)
    .filter(([instrument]) => declared.subclass_of[instrument] === subclass)
    .reduce((sum, [, exposure]) => sum + exposure, 0);

  return {
    name: 'per_subclass_deployment_cap',
    allowedAdditional: cap - deployedToSubclass,
  };
};

/** Spec steps 2–6 plus ADR-0018 D5, in binding order. The array IS the pipeline. */
const ENTRY_CAP_GATES: readonly EntryCapGate[] = [
  perTradeSizeCap,
  perAssetExposureCap,
  perAssetClassExposureCap,
  perSubclassDeploymentCap,
  portfolioGrossExposureCap,
  concentrationCorrelationCap,
];

function applyCritic(
  critic: { verdict: RiskCriticVerdict['verdict']; max_notional: number | null; reasoning: string },
  notional: number,
  finalSize: number,
  reasons: string[],
): { changed: boolean; notional: number; rejected: boolean } {
  if (critic.verdict === 'pass' || critic.verdict === 'unavailable') {
    return {
      changed: false,
      notional: finalSize * (critic.verdict === 'pass' ? 1 : 1),
      rejected: false,
    };
  }

  if (critic.verdict === 'reject') {
    reasons.push(`risk_critic: ${critic.reasoning}`);
    return { changed: true, notional, rejected: true };
  }

  const criticCap = critic.max_notional ?? notional;
  if (criticCap >= notional) {
    return { changed: false, notional, rejected: false };
  }

  reasons.push(
    `risk_critic: trimmed notional from ${notional} to ${criticCap} (${critic.reasoning})`,
  );
  return { changed: true, notional: criticCap, rejected: false };
}
