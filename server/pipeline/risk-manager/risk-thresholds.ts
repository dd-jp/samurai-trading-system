/**
 * The `risk_thresholds` naming contract (#433).
 *
 * feedback-loop-spec.md ("Module: Guardrailed Tuning") states the obligation
 * plainly: *"FL's tuning only takes effect if the Trader reads its strategy
 * params, and the Risk Manager reads its thresholds, from the mutable shared
 * store at decision/eval time — not from static config baked in at startup."*
 *
 * `autoTighten` has written to that table since #93. Nothing read it. So the
 * system's defensive response to a detected dead edge — tightening every risk
 * threshold toward its guardrail bound on a kill-line breach — moved a number
 * in SQLite, recorded an `AdjustmentLog` entry, and changed no decision. After
 * ADR-0007 removed the human approval gate, auto-tighten is one of the few
 * self-defence mechanisms left, which makes a write nobody reads a materially
 * worse gap than it was when it was filed.
 *
 * ## Why this file exists at all
 *
 * The blocker was never the reading — it was that no writer had ever agreed
 * which `risk_thresholds` KEY corresponds to which `RiskConfig` FIELD.
 * `paper-profile.ts` says so in as many words and ships `risk_thresholds: {}`
 * rather than guess, because "declaring names against a store nothing
 * populates would buy an audit trail of no-ops" and, worse, would put
 * safety-limit bounds under keys nothing honours. This module is that missing
 * agreement, in one place, so the dial declaration, the seeder and the reader
 * cannot drift apart.
 *
 * ## What is tunable, and what deliberately is not
 *
 * Every key below is a NOTIONAL CAP in account currency, and for every one of
 * them tightening means DECREASING. That uniformity is the point: `autoTighten`
 * drives all of them toward one bound, and a mixed set — where tightening some
 * dials meant increasing them — would make a single "tighten everything" sweep
 * unreadable.
 *
 * Excluded on purpose:
 * - `concentration.threshold` — a correlation coefficient, not a cap, and its
 *   tighten direction is inverted (a LOWER threshold is stricter). Tunable in
 *   principle; it does not belong in a sweep whose other members are dollars.
 * - `min_viable_size` — a dust FLOOR. Raising it rejects more small trades,
 *   which is not obviously "tighter" in the loss-bounding sense the kill-line
 *   response means.
 * - `cii_threshold` — drives a WARNING, not a limit. Tightening it changes no
 *   decision, which is the exact defect this ticket exists to fix.
 */
import { assertThresholdsWithinBounds } from '../../shared/index.js';
import type { RiskConfig } from './types.js';

/**
 * Every tunable key, and how it lands on a `RiskConfig`.
 *
 * Keys are the `RiskConfig` field names verbatim, with the two nested ones
 * flattened by underscore. Deliberately NOT `RiskDecision.binding_constraint`'s
 * vocabulary (`per_trade_size_cap`, `per_asset_exposure_cap`, …): that names
 * the CHECK STEP a decision stopped at, this names the CONFIG FIELD a dial
 * writes. Two vocabularies for two things, and conflating them would make the
 * dial that tightens `max_position_size` look like it tightens a decision. Chosen so the mapping is legible without this table
 * in front of you — an operator reading `per_asset_class_cap_crypto` in the
 * `risk_thresholds` table can find the field it drives without a lookup.
 *
 * **`per_subclass_deployment_cap` is deliberately NOT here** (#703, step A6),
 * and its absence is load-bearing rather than an oversight. ADR-0018 D5's
 * deployment envelope is measured drift-removed with zero edge assumed — it
 * binds regardless of how good the signal turns out to be. A dial on it would
 * let the Feedback Loop widen the record's only drawdown protection in exactly
 * the run where the loop had learned to be confident, which is the run where
 * the envelope matters most. `per-subclass-deployment-cap.test.ts` asserts the
 * absence so an unrelated widening of this list cannot quietly grant one.
 */
export const RISK_THRESHOLD_KEYS = [
  'max_position_size',
  'per_asset_cap',
  'per_asset_class_cap_crypto',
  'per_asset_class_cap_stocks',
  'portfolio_gross_cap',
  'concentration_cap',
] as const;

export type RiskThresholdKey = (typeof RISK_THRESHOLD_KEYS)[number];

/**
 * Reads each tunable value out of a static `RiskConfig` — the seeder's source,
 * so the table starts holding exactly what the process would otherwise have
 * used, and `autoTighten` has a current value to step from instead of skipping
 * every dial as `current === undefined`.
 */
export function riskThresholdsFrom(config: RiskConfig): Partial<Record<RiskThresholdKey, number>> {
  const candidates: Record<RiskThresholdKey, number | undefined> = {
    max_position_size: config.max_position_size,
    per_asset_cap: config.per_asset_cap,
    per_asset_class_cap_crypto: config.per_asset_class_cap?.crypto,
    per_asset_class_cap_stocks: config.per_asset_class_cap?.stocks,
    portfolio_gross_cap: config.portfolio_gross_cap,
    concentration_cap: config.concentration?.cap,
  };

  // Only what the config actually carries. `RiskConfig` requires every field,
  // so a gap here means a partial object cast past the compiler — which is
  // what a test fixture is. Seeding what exists and skipping what does not
  // beats throwing at startup over a field the run may never consult.
  return Object.fromEntries(
    Object.entries(candidates).filter(
      ([, value]) => value !== undefined && Number.isFinite(value) && value > 0,
    ),
  ) as Partial<Record<RiskThresholdKey, number>>;
}

/**
 * Where the Risk Manager reads its live thresholds from. A narrow port rather
 * than the whole `TuningStore`: Risk reads six numbers and writes nothing, and
 * an edge from risk-manager to the Feedback Loop's store interface would
 * invert the ownership the specs describe. `SqliteTuningStore` satisfies it
 * structurally.
 */
export interface RiskThresholdSource {
  getRiskThresholds(): Record<string, number>;
}

/**
 * Overlays the live thresholds onto the static config.
 *
 * The store is authoritative where it has a value, and the static config is
 * the fallback where it does not. Deliberately NOT "the tighter of the two":
 * a loosening that reached the table has already been through the Feedback
 * Loop's guardrail bounds and, for a threshold dial, a human approval
 * (`daily-cycle.ts` queues it into `loosen_pending_approval` and never applies
 * it unapproved). Second-guessing that here would make the approval mean
 * nothing.
 *
 * A value that is not a positive finite number is ignored rather than applied.
 * That is not defensive decoration: these are the numbers that bound loss, and
 * a NaN cap compares false against every notional, so applying one would
 * silently disable the gate it is supposed to enforce. A zero or negative cap
 * would reject everything — safe, but indistinguishable from a broken store,
 * and the static config is the better answer to a row we cannot read.
 */
export function resolveRiskConfig(
  base: RiskConfig,
  live: Record<string, number>,
): { config: RiskConfig; applied: Partial<Record<RiskThresholdKey, number>> } {
  // #638: the clamp on the LIVE path, and the reason it checks the whole `live`
  // record rather than only the six keys this function applies.
  //
  // A boot-time-only clamp constrains nothing the Feedback Loop does: these
  // rows are re-read on every `evaluate()`, so a value written between two
  // ticks binds on the second one without passing through startup again. And
  // once ADR-0013's loosen gate is gone (#736), the loop moves a dial with
  // nobody in the path at all.
  //
  // Checking every row means the guard travels with the ALLOW-LIST rather than
  // with today's contents: a guarded threshold added to `RISK_THRESHOLD_KEYS`
  // later is bounded here the moment it is added, and a guarded row that is
  // present but NOT applied still stops the process — a stored value that
  // crosses a bright line means something in the system tried to cross it, and
  // ignoring the row would leave that silent.
  assertThresholdsWithinBounds(live, 'RiskManager live threshold read (risk_thresholds table)');

  const applied: Partial<Record<RiskThresholdKey, number>> = {};
  for (const key of RISK_THRESHOLD_KEYS) {
    const value = live[key];
    if (value === undefined || !Number.isFinite(value) || value <= 0) continue;
    applied[key] = value;
  }

  if (Object.keys(applied).length === 0) return { config: base, applied };

  return {
    config: {
      ...base,
      max_position_size: applied.max_position_size ?? base.max_position_size,
      per_asset_cap: applied.per_asset_cap ?? base.per_asset_cap,
      per_asset_class_cap: {
        crypto: applied.per_asset_class_cap_crypto ?? base.per_asset_class_cap.crypto,
        stocks: applied.per_asset_class_cap_stocks ?? base.per_asset_class_cap.stocks,
      },
      portfolio_gross_cap: applied.portfolio_gross_cap ?? base.portfolio_gross_cap,
      concentration: {
        ...base.concentration,
        cap: applied.concentration_cap ?? base.concentration.cap,
      },
    },
    applied,
  };
}
