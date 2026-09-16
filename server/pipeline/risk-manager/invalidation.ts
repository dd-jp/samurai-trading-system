/**
 * The invalidation half of check-pipeline step 7 — the DETERMINISTIC half.
 *
 * `devils-advocate-spec.md` designed a standalone `invalidation` stage; David
 * declined it as a stage on 2026-09-02 (*"fold this to risk critic"*) and
 * [#997](https://github.com/dd-jp/samurai-trading-system/issues/997) fixed how
 * the mechanism folds in. `docs/specs/risk-manager-spec.md`, "Module: Risk
 * Critic — the invalidation fold", is the spec this file implements.
 *
 * ## Why this is a separate module from `critic.ts`
 *
 * #997 Q1: only condition EMISSION is LLM work. `critic.ts` owns the single
 * model call (prose and raw conditions come back from the same pass, so the
 * step-7 seam accumulates no second LLM pass and the ~$1/yr envelope holds).
 * Everything here — the validator, the tri-state evaluator, the reason lines
 * `evaluate()` records — is deterministic code, unit-testable in isolation and
 * deliberately outside the module the spec defines as the qualitative pass.
 *
 * ## The load-bearing rule
 *
 * **The LLM names what to check; deterministic code does the checking, so a
 * model cannot produce a breach — only propose a condition.** That is enforced
 * by the TYPES, not by a prompt instruction: `RawCondition` below has no
 * `state` field for a model to fill in, so a response containing
 * `"state":"breached"` is read as an unknown property and discarded. Every
 * `EvaluatedCondition.state` in this system is produced by `evaluateConditions`
 * from a measured read.
 *
 * ## Failure posture
 *
 * Partial-tolerant (#997 Q2a). Nothing in this file can void the prose verdict:
 * a conditions half that is absent, unreadable, or emptied by the drop rules
 * yields an empty list, which reports `no_conditions` and enforces nothing.
 * `unevaluable` likewise has no enforcement effect — a data gap must never
 * block a trade. Only a MEASURED `breached` has teeth, and the authority to act
 * on it lives in `evaluate()` (#997 Q2b), not here.
 */

import {
  type BarWindow,
  INDICATOR_KINDS,
  type IndicatorKind,
  type IndicatorSpec,
  type MarketDataService,
} from '../../providers/market-data-service/index.js';
import type { OrderIntent } from '../../shared/index.js';
import type {
  DroppedCondition,
  EvaluatedCondition,
  InvalidationComparator,
  InvalidationCondition,
  InvalidationDropReason,
  InvalidationObservable,
  RiskCriticVerdict,
} from './types.js';

/**
 * The ceiling on surviving conditions. A checklist longer than this is not one
 * a human reads, and `devils-advocate-spec.md` user story 10 asks for 3-5.
 *
 * Only the CEILING is enforced. A list shorter than 3 is recorded and kept —
 * dropping a valid 2-condition set would enforce strictly less than the
 * emission supports, which is the same safety regression as discarding the
 * prose verdict over a malformed conditions half.
 */
export const MAX_INVALIDATION_CONDITIONS = 5;

/**
 * How many elements of a model-supplied `conditions` array are INSPECTED.
 *
 * The accepted ceiling above bounds what gets enforced; it does not bound the
 * audit trail. Every refusal becomes a `DroppedCondition`, a reason line on
 * the `RiskDecision`, and JSON in `risk_critic_log` — so validating the whole
 * array makes the emission's length the only limit on all three, and a looping
 * or hostile emission of 1000 elements writes 1000 of each. Past this bound
 * the remainder is recorded as ONE summarising `over_cap` drop naming the
 * count: the flood stays auditable without being amplified.
 */
export const MAX_INSPECTED_CONDITIONS = 16;

/**
 * The ceiling on `lookback` for an indicator spec or a bars window (#994
 * review, PR #1067) — otherwise a model emission of `lookback: 1_000_000`
 * validates and triggers a huge `getBars`/indicator read on the path an order
 * is waiting on (`withinDeadline` races the read against the budget but does
 * not cancel it, so an unbounded fetch is an unbounded wait either way).
 *
 * Sized off the largest lookback any real caller in this codebase asks the
 * Market Data Service for on the indicator/bars path: `technical-analyst.ts`'s
 * `RVOL_5M_LOOKBACK` = `(RVOL_SESSION_WINDOW + 2) * BARS_PER_SESSION_5M` =
 * `12 * 78` = 936 bars (ten sessions of 5m RVOL history plus a two-session
 * margin). 1000 is a round number comfortably above that measured ceiling
 * without being large enough to make the read itself the problem.
 */
export const MAX_INVALIDATION_LOOKBACK = 1000;

/** `binding_constraint` for a hard-reject on a measured breach. DISTINCT from `risk_critic:reject` (#997 Q2b). */
export const INVALIDATED_BINDING_CONSTRAINT = 'risk_critic:invalidated';

/** Cap on any single audit string kept from the model's output */
const MAX_RAW_CHARS = 200;

/** The one runtime list of the union `types.ts` declares — the union is the source, this is its checkable form */
const COMPARATORS: readonly InvalidationComparator[] = ['<', '<=', '>', '>='];
type Comparator = InvalidationComparator;

const INDICATOR_KIND_SET: ReadonlySet<string> = new Set<string>(INDICATOR_KINDS);

/**
 * Which comparator direction means "the thesis is FAILING", per observable.
 *
 * `Partial`, and the partiality is load-bearing (`devils-advocate-spec.md`):
 * an indicator kind with no entry here is NOT dropped on direction — it falls
 * through to the other rules. Silently dropping on an unmapped observable
 * would make adding a member to `INDICATOR_KINDS` a trade-blocking event.
 */
type FalsifyingDirection =
  /** Price-like and momentum: falsified by moving AGAINST the intent's side */
  | 'opposite_side'
  /** Participation: falsified by THINNING, regardless of side */
  | 'downward_only';

const INDICATOR_DIRECTION: Partial<Record<IndicatorKind, FalsifyingDirection>> = {
  sma: 'opposite_side',
  ema: 'opposite_side',
  rsi: 'opposite_side',
};

interface ThresholdRange {
  min: number;
  max: number;
  /** `true` when `min` itself is not an admissible threshold (a mark of 0 is not a price) */
  exclusive_min?: boolean;
}

/**
 * Declared valid ranges. `Partial` for the same reason as the direction table:
 * an unmapped kind falls through un-dropped rather than blocking a trade.
 *
 * Sourced from the indicator implementations (`providers/market-data-service/
 * indicators.ts`), not guessed: `rsi`/`adx` are 0-100 oscillators,
 * `donchian_pos` is a [0, 1] fraction, `atr`/`atr_pct` and the
 * `bb_kc_squeeze` ratio are non-negative, and `sma`/`ema`/`macd_histogram`
 * are deliberately absent because they carry price units with no bound this
 * module can assert.
 */
const INDICATOR_RANGE: Partial<Record<IndicatorKind, ThresholdRange>> = {
  rsi: { min: 0, max: 100 },
  adx: { min: 0, max: 100 },
  donchian_pos: { min: 0, max: 1 },
  atr: { min: 0, max: Number.POSITIVE_INFINITY },
  atr_pct: { min: 0, max: Number.POSITIVE_INFINITY },
  bb_kc_squeeze: { min: 0, max: Number.POSITIVE_INFINITY },
};

/** A mark is a price; a volume ratio is a non-negative ratio. Both exclude a zero threshold as degenerate. */
const MARK_RANGE: ThresholdRange = { min: 0, max: Number.POSITIVE_INFINITY, exclusive_min: true };
const VOLUME_RATIO_RANGE: ThresholdRange = {
  min: 0,
  max: Number.POSITIVE_INFINITY,
  exclusive_min: true,
};

/**
 * What a model may emit. NOTE what is missing: there is no `state`, and there
 * is no severity/weight/confidence. Both omissions are the contract, not an
 * oversight — see the module header.
 */
interface RawCondition {
  id?: unknown;
  observable?: unknown;
  comparator?: unknown;
  threshold?: unknown;
  rationale?: unknown;
}

function bounded(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return (text ?? String(value)).slice(0, MAX_RAW_CHARS);
}

function drop(
  id: string | null,
  raw: unknown,
  reason: DroppedCondition['reason'],
): DroppedCondition {
  return { id, raw: bounded(raw), reason };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** The result of validating one emission: what survived, and what did not and why */
export interface ValidatedConditions {
  accepted: InvalidationCondition[];
  dropped: DroppedCondition[];
}

/**
 * `params` is optional; when present it must be a plain object whose every
 * value is a finite number. Arrays are rejected even though
 * `typeof [] === 'object'` and every element can be finite — `Object.values`
 * on an array yields its elements, which would otherwise pass this check and
 * then get cast to `Record<string, number>` downstream. Shared by
 * `readIndicatorSpec` (known `kind`) and `isObservable`'s retired-`kind`
 * branch (#1068), so the two never drift on what counts as a well-formed
 * `params` map.
 */
function isWellFormedParams(value: unknown): value is Record<string, number> | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isFiniteNumber);
}

function readIndicatorSpec(
  value: unknown,
): IndicatorSpec | 'unparseable' | 'unknown_indicator' | 'lookback_too_large' {
  if (typeof value !== 'object' || value === null) return 'unparseable';
  const spec = value as {
    indicator?: unknown;
    params?: unknown;
    lookback?: unknown;
    timeframe?: unknown;
  };
  if (!isNonEmptyString(spec.indicator)) return 'unparseable';
  if (!INDICATOR_KIND_SET.has(spec.indicator)) return 'unknown_indicator';
  if (!isPositiveInteger(spec.lookback)) return 'unparseable';
  if (spec.lookback > MAX_INVALIDATION_LOOKBACK) return 'lookback_too_large';
  if (!isNonEmptyString(spec.timeframe)) return 'unparseable';
  if (!isWellFormedParams(spec.params)) return 'unparseable';

  return {
    indicator: spec.indicator as IndicatorKind,
    params: spec.params === undefined ? {} : (spec.params as Record<string, number>),
    lookback: spec.lookback,
    timeframe: spec.timeframe,
  };
}

function readBarWindow(value: unknown): BarWindow | 'unparseable' | 'lookback_too_large' {
  if (typeof value !== 'object' || value === null) return 'unparseable';
  const window = value as { timeframe?: unknown; lookback?: unknown };
  if (!isNonEmptyString(window.timeframe)) return 'unparseable';
  // Two bars minimum: the ratio needs a latest bar AND a baseline to divide by
  if (!isPositiveInteger(window.lookback) || window.lookback < 2) return 'unparseable';
  if (window.lookback > MAX_INVALIDATION_LOOKBACK) return 'lookback_too_large';
  return { timeframe: window.timeframe, lookback: window.lookback };
}

function readIndicatorObservable(
  rawSpec: unknown,
): InvalidationObservable | 'unparseable' | 'unknown_indicator' | 'lookback_too_large' {
  const spec = readIndicatorSpec(rawSpec);
  if (spec === 'unparseable' || spec === 'unknown_indicator' || spec === 'lookback_too_large') {
    return spec;
  }
  return { kind: 'indicator', spec };
}

function readBarsObservable(
  measure: unknown,
  rawWindow: unknown,
): InvalidationObservable | 'unparseable' | 'lookback_too_large' {
  if (measure !== 'volume_ratio') return 'unparseable';
  const window = readBarWindow(rawWindow);
  if (window === 'unparseable' || window === 'lookback_too_large') return window;
  return { kind: 'bars', window, measure: 'volume_ratio' };
}

function readObservable(
  value: unknown,
):
  | InvalidationObservable
  | 'unparseable'
  | 'unknown_observable'
  | 'unknown_indicator'
  | 'lookback_too_large' {
  if (typeof value !== 'object' || value === null) return 'unparseable';
  const observable = value as {
    kind?: unknown;
    spec?: unknown;
    window?: unknown;
    measure?: unknown;
  };

  switch (observable.kind) {
    case 'mark':
      return { kind: 'mark' };
    case 'indicator':
      return readIndicatorObservable(observable.spec);
    case 'bars':
      return readBarsObservable(observable.measure, observable.window);
    default:
      // Anything else — including the 2026-08-05 proposal's `mi_context`,
      // which this fold deliberately does not carry — binds to no service
      // the Risk step can read at decision time
      return 'unknown_observable';
  }
}

function rangeFor(observable: InvalidationObservable): ThresholdRange | undefined {
  switch (observable.kind) {
    case 'mark':
      return MARK_RANGE;
    case 'bars':
      return VOLUME_RATIO_RANGE;
    case 'indicator':
      return INDICATOR_RANGE[observable.spec.indicator];
  }
}

function directionFor(observable: InvalidationObservable): FalsifyingDirection | undefined {
  switch (observable.kind) {
    case 'mark':
      return 'opposite_side';
    case 'bars':
      return 'downward_only';
    case 'indicator':
      return INDICATOR_DIRECTION[observable.spec.indicator];
  }
}

function pointsDown(comparator: Comparator): boolean {
  return comparator === '<' || comparator === '<=';
}

/**
 * Would this condition fire when the thesis is WORKING rather than failing?
 *
 * NOT a naive side↔comparator mapping: `devils-advocate-spec.md` supplies the
 * counterexample (a rising participation count on a long thesis is coherent,
 * because reflexive observables do not invert with side). Direction semantics
 * are declared per observable, and an observable with none declared is never
 * dropped by this rule.
 */
function directionIsCoherent(
  observable: InvalidationObservable,
  comparator: Comparator,
  side: OrderIntent['side'],
): boolean {
  const direction = directionFor(observable);
  if (direction === undefined) return true;
  if (direction === 'downward_only') return pointsDown(comparator);
  return side === 'buy' ? pointsDown(comparator) : !pointsDown(comparator);
}

function thresholdInRange(observable: InvalidationObservable, threshold: number): boolean {
  const range = rangeFor(observable);
  if (range === undefined) return true;
  if (threshold > range.max) return false;
  return range.exclusive_min === true ? threshold > range.min : threshold >= range.min;
}

type ConditionClassification =
  | { id: string | null; ok: false; reason: InvalidationDropReason }
  | { id: string; ok: true; condition: InvalidationCondition };

/**
 * One element of `validateConditions`'s loop, pulled out so the ceiling check
 * and every drop reason stay in the same declared-precedence order they had
 * inline: `acceptedCount` is `accepted.length` at the moment this element is
 * reached, so `over_cap` still only fires once an on-merits-valid condition
 * would be the one to overflow the cap.
 */
function classifyRawCondition(
  candidate: RawCondition,
  side: OrderIntent['side'],
  acceptedCount: number,
): ConditionClassification {
  const id = isNonEmptyString(candidate.id) ? candidate.id.trim().slice(0, MAX_RAW_CHARS) : null;

  if (id === null || !isNonEmptyString(candidate.rationale)) {
    return { id, ok: false, reason: 'unparseable' };
  }
  if (!COMPARATORS.includes(candidate.comparator as Comparator)) {
    return { id, ok: false, reason: 'unparseable' };
  }
  if (!isFiniteNumber(candidate.threshold)) {
    return { id, ok: false, reason: 'unparseable' };
  }

  const observable = readObservable(candidate.observable);
  if (observable === 'unparseable' || observable === 'unknown_observable') {
    return { id, ok: false, reason: observable };
  }
  if (observable === 'unknown_indicator' || observable === 'lookback_too_large') {
    return { id, ok: false, reason: observable };
  }

  const comparator = candidate.comparator as Comparator;
  if (!thresholdInRange(observable, candidate.threshold)) {
    return { id, ok: false, reason: 'threshold_out_of_range' };
  }
  if (!directionIsCoherent(observable, comparator, side)) {
    return { id, ok: false, reason: 'direction_incoherent' };
  }

  // The ceiling is applied LAST, so a surplus condition that would have been
  // dropped on its own merits is recorded with the real reason rather than
  // hidden behind `over_cap`
  if (acceptedCount >= MAX_INVALIDATION_CONDITIONS) {
    return { id, ok: false, reason: 'over_cap' };
  }

  return {
    id,
    ok: true,
    condition: {
      id,
      observable,
      comparator,
      threshold: candidate.threshold,
      rationale: candidate.rationale.trim().slice(0, MAX_RAW_CHARS),
    },
  };
}

/**
 * The deterministic validator: raw model output in, a checkable list plus an
 * audited list of refusals out. Never throws, and never coerces — a malformed
 * condition is DROPPED, never repaired into a half-understood predicate.
 *
 * `raw` is whatever the model's JSON carried under `conditions`. `undefined`
 * (the field was absent, or the row predates the fold) yields two empty lists:
 * nothing was proposed, so nothing was refused.
 */
export function validateConditions(raw: unknown, side: OrderIntent['side']): ValidatedConditions {
  if (raw === undefined || raw === null) return { accepted: [], dropped: [] };
  if (!Array.isArray(raw)) {
    return { accepted: [], dropped: [drop(null, raw, 'unparseable')] };
  }

  const accepted: InvalidationCondition[] = [];
  const dropped: DroppedCondition[] = [];

  for (const element of raw.slice(0, MAX_INSPECTED_CONDITIONS)) {
    if (typeof element !== 'object' || element === null) {
      dropped.push(drop(null, element, 'unparseable'));
      continue;
    }
    const result = classifyRawCondition(element as RawCondition, side, accepted.length);
    if (result.ok) {
      accepted.push(result.condition);
    } else {
      dropped.push(drop(result.id, element, result.reason));
    }
  }

  if (raw.length > MAX_INSPECTED_CONDITIONS) {
    const uninspected = raw.length - MAX_INSPECTED_CONDITIONS;
    dropped.push(
      drop(
        null,
        `${uninspected} further condition(s) not inspected — the emission carried ${raw.length}, ` +
          `past the ${MAX_INSPECTED_CONDITIONS}-element inspection bound`,
        'over_cap',
      ),
    );
  }

  return { accepted, dropped };
}

/**
 * ## Reading a PERSISTED conditions half back (#994 review, tightened #1068)
 *
 * `risk_critic_log.conditions_json` is a TEXT column: its contents are
 * whatever a past process wrote, plus whatever a hand-edit or a partial write
 * left behind. A cast alone (`parsed as EvaluatedCondition[]`) buys nothing —
 * `[{}]` then reaches `evaluate()` and throws reading `.observable`, and
 * `[{"state":"breached"}]` reaches a HARD REJECT with no measurement behind
 * it, which is exactly the "a model cannot produce a breach" rule defeated by
 * the storage layer.
 *
 * So the FULL shape is checked on read (`risk-manager-spec.md`, "persistence &
 * replay"): finite `observed` on a measured state, `observed: null` on
 * `unevaluable`, a well-formed `window` on a `bars` observable, and an
 * indicator's `lookback` (at or under `MAX_INVALIDATION_LOOKBACK`),
 * `timeframe`, and `params` — all three are re-checked independently of
 * whether the indicator `kind` itself is still recognized, so a retired
 * `kind` cannot smuggle an oversized lookback, a missing timeframe, or a
 * malformed params map past the registry-drift leniency below.
 *
 * Per-element, not whole-list: a malformed element is DROPPED from the
 * replayed list rather than collapsing the whole row. If nothing survives,
 * the row reports `no_conditions` — the same marker a pre-fold row produces
 * (#997 Q3) — never a hard reject and never a silent accept of a breach.
 * `readPersistedDroppedConditions` (the drop-audit column) is unaffected and
 * keeps its original all-or-nothing rule: that column has zero enforcement
 * effect either way, so there is no safety reason to touch it here.
 *
 * One deliberate exception survives the tightening: an indicator `kind` that
 * has since left `INDICATOR_KINDS` is still accepted when everything else
 * about it is well-formed, so a historical row replays to the decision it
 * produced when the state was actually measured. Dropping it on registry
 * drift would silently change a historical verdict for a reason that has
 * nothing to do with what happened at the time.
 */
// `readIndicatorSpec` reports the retired-`kind` case before it ever inspects
// `lookback`, `timeframe`, or `params`, so all three have to be re-checked
// independently here: registry drift may not smuggle an oversized lookback,
// a missing timeframe, or a malformed params map past the read-time safety
// checks
function isRetiredIndicatorSpecWellFormed(spec: unknown): boolean {
  const rawSpec = spec as { lookback?: unknown; timeframe?: unknown; params?: unknown };
  return (
    isPositiveInteger(rawSpec.lookback) &&
    rawSpec.lookback <= MAX_INVALIDATION_LOOKBACK &&
    isNonEmptyString(rawSpec.timeframe) &&
    isWellFormedParams(rawSpec.params)
  );
}

function isValidIndicatorObservable(rawSpec: unknown): boolean {
  const spec = readIndicatorSpec(rawSpec);
  if (spec === 'unparseable' || spec === 'lookback_too_large') return false;
  // `unknown_indicator` is deliberately still accepted (registry-drift leniency, above)
  if (spec === 'unknown_indicator') return isRetiredIndicatorSpecWellFormed(rawSpec);
  return true;
}

function isValidBarsObservable(measure: unknown, rawWindow: unknown): boolean {
  if (measure !== 'volume_ratio') return false;
  const window = readBarWindow(rawWindow);
  return window !== 'unparseable' && window !== 'lookback_too_large';
}

function isObservable(value: unknown): value is InvalidationObservable {
  if (typeof value !== 'object' || value === null) return false;
  const observable = value as {
    kind?: unknown;
    spec?: unknown;
    window?: unknown;
    measure?: unknown;
  };
  switch (observable.kind) {
    case 'mark':
      return true;
    case 'indicator':
      return isValidIndicatorObservable(observable.spec);
    case 'bars':
      return isValidBarsObservable(observable.measure, observable.window);
    default:
      return false;
  }
}

function isInvalidationCondition(value: unknown): value is InvalidationCondition {
  if (typeof value !== 'object' || value === null) return false;
  const condition = value as Partial<InvalidationCondition>;
  return (
    isNonEmptyString(condition.id) &&
    isNonEmptyString(condition.rationale) &&
    isFiniteNumber(condition.threshold) &&
    COMPARATORS.includes(condition.comparator as Comparator) &&
    isObservable(condition.observable)
  );
}

/** A well-formed, MEASURED entry: a readable condition, a state in the tri-state union, and `observed` null iff `unevaluable` */
function isEvaluatedCondition(value: unknown): value is EvaluatedCondition {
  if (typeof value !== 'object' || value === null) return false;
  const evaluated = value as Partial<EvaluatedCondition>;
  if (!isInvalidationCondition(evaluated.condition)) return false;
  if (evaluated.state === 'unevaluable') return evaluated.observed === null;
  if (evaluated.state !== 'breached' && evaluated.state !== 'not_breached') return false;
  return isFiniteNumber(evaluated.observed);
}

const DROP_REASONS: readonly InvalidationDropReason[] = [
  'unparseable',
  'unknown_observable',
  'unknown_indicator',
  'lookback_too_large',
  'threshold_out_of_range',
  'direction_incoherent',
  'over_cap',
];

function isDroppedCondition(value: unknown): value is DroppedCondition {
  if (typeof value !== 'object' || value === null) return false;
  const dropped = value as Partial<DroppedCondition>;
  if (dropped.id !== null && !isNonEmptyString(dropped.id)) return false;
  if (typeof dropped.raw !== 'string') return false;
  return DROP_REASONS.includes(dropped.reason as InvalidationDropReason);
}

function readListStrict<T>(
  parsed: unknown,
  isElement: (value: unknown) => value is T,
): T[] | undefined {
  if (!Array.isArray(parsed)) return undefined;
  return parsed.every(isElement) ? (parsed as T[]) : undefined;
}

/**
 * Parses a persisted `conditions` list ELEMENT-WISE (#1068): a malformed
 * element is dropped, the well-formed survivors are kept, and the result is
 * `undefined` (= `no_conditions`) only when NOTHING survives — never a hard
 * reject on a partially-corrupt row, and never enforcement built on an
 * element that failed the shape check. See the block comment above
 * `isObservable` for the full rationale and the one deliberate leniency
 * (registry-drift on `kind`).
 */
export function readPersistedConditions(parsed: unknown): EvaluatedCondition[] | undefined {
  if (!Array.isArray(parsed)) return undefined;
  // An emitted-but-empty list stays `[]`, not `undefined` — `writeJsonList`
  // (critic-store.ts) writes "nothing emitted" as NULL and "everything
  // dropped at validation time" as `[]` specifically so the two stay
  // distinguishable in the row; collapsing `[]` to `undefined` here would
  // erase that distinction on read even though nothing was malformed
  if (parsed.length === 0) return [];
  const survivors = parsed.filter(isEvaluatedCondition);
  return survivors.length === 0 ? undefined : survivors;
}

/**
 * Parses a persisted `dropped_conditions` list, ALL-OR-NOTHING (unlike
 * `readPersistedConditions` above): this column is audit-only, with zero
 * enforcement effect either way, so a malformed element voids the whole list
 * rather than being salvaged element-wise
 */
export function readPersistedDroppedConditions(parsed: unknown): DroppedCondition[] | undefined {
  return readListStrict(parsed, isDroppedCondition);
}

export interface EvaluateConditionsInput {
  conditions: readonly InvalidationCondition[];
  instrument: string;
  marketData: MarketDataService;
  /** Point-in-time read for every lookup — never wall-clock */
  asOf: Date;
  /**
   * The producer's own budget, shared with the LLM call in front of it.
   *
   * Without it these reads run unbounded in front of an order the tick is
   * waiting on: the producer's `AbortController` cancels the model call, but a
   * market-data seam that never answers is a second, unbounded wait. An
   * aborted read is a data gap like any other, so it lands on `unevaluable`.
   */
  signal?: AbortSignal;
}

function volumeRatioFromBars(
  bars: Awaited<ReturnType<MarketDataService['getBars']>>,
): number | null {
  if (bars.length < 2) return null;
  const latest = bars[bars.length - 1];
  const baseline = bars.slice(0, -1);
  if (latest === undefined) return null;
  const mean = baseline.reduce((total, bar) => total + bar.volume, 0) / baseline.length;
  // A zero baseline has no ratio to report — an untraded window is a data
  // gap, not a falsified thesis
  if (!isFiniteNumber(mean) || mean === 0) return null;
  const ratio = latest.volume / mean;
  return isFiniteNumber(ratio) ? ratio : null;
}

/**
 * Measures one observable, or returns `null` for "could not be measured".
 *
 * `null` is the ONLY path to `unevaluable`, and it is reached mechanically: a
 * read that threw, a non-finite value, or fewer bars than the measure needs.
 * There is no discretionary path into it.
 */
async function observe(
  observable: InvalidationObservable,
  instrument: string,
  marketData: MarketDataService,
  asOf: Date,
): Promise<number | null> {
  try {
    switch (observable.kind) {
      case 'mark': {
        const mark = await marketData.getMark(instrument, asOf);
        return isFiniteNumber(mark.price) ? mark.price : null;
      }
      case 'indicator': {
        const value = await marketData.getIndicator(instrument, observable.spec, asOf);
        return isFiniteNumber(value.value) ? value.value : null;
      }
      case 'bars': {
        const bars = await marketData.getBars(instrument, observable.window, asOf);
        return volumeRatioFromBars(bars);
      }
    }
  } catch {
    // Every read failure is a data gap, which fails OPEN as `unevaluable`
    // Swallowed rather than propagated on purpose: this runs in front of an
    // order the tick is waiting on, and a market-data outage must degrade the
    // checklist, not take the risk stage down
    return null;
  }
}

/** Resolves to `null` — a data gap, hence `unevaluable` — as soon as the budget expires, whether or not the read ever answers */
async function withinDeadline(
  read: Promise<number | null>,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  if (signal === undefined) return read;
  if (signal.aborted) return null;
  return Promise.race([
    read,
    new Promise<null>((resolve) => {
      signal.addEventListener('abort', () => resolve(null), { once: true });
    }),
  ]);
}

function isBreached(observed: number, comparator: Comparator, threshold: number): boolean {
  switch (comparator) {
    case '<':
      return observed < threshold;
    case '<=':
      return observed <= threshold;
    case '>':
      return observed > threshold;
    case '>=':
      return observed >= threshold;
  }
}

/**
 * Evaluates every surviving condition against the same clock-gated seams the
 * rest of the Risk step reads, at `asOf` — no-lookahead by construction.
 *
 * Never throws: a failed read becomes `unevaluable`, which has no enforcement
 * effect.
 */
export async function evaluateConditions(
  input: EvaluateConditionsInput,
): Promise<EvaluatedCondition[]> {
  const { conditions, instrument, marketData, asOf, signal } = input;
  return Promise.all(
    conditions.map(async (condition): Promise<EvaluatedCondition> => {
      const observed = await withinDeadline(
        observe(condition.observable, instrument, marketData, asOf),
        signal,
      );
      if (observed === null) {
        return { condition, state: 'unevaluable', observed: null };
      }
      return {
        condition,
        state: isBreached(observed, condition.comparator, condition.threshold)
          ? 'breached'
          : 'not_breached',
        observed,
      };
    }),
  );
}

/**
 * The single "nothing checkable came out of this pass" reason line.
 *
 * One string for all four causes — nothing emitted, everything dropped, an
 * unreadable conditions half, and a row written before the fold — because
 * #997's answer to Q2a and Q3 is that they are one code path. It is RECORDED
 * rather than silent so that a systematically malformed prompt is visible
 * instead of degrading into "conditions never fire" for a month.
 */
export const NO_CONDITIONS_REASON =
  'risk_critic: no_conditions — the critic supplied no checkable invalidation condition; ' +
  'the prose verdict stands on its own and conditions enforce nothing';

function describeCondition(evaluated: EvaluatedCondition): string {
  const { condition, state, observed } = evaluated;
  const kind =
    condition.observable.kind === 'indicator'
      ? `indicator:${condition.observable.spec.indicator}`
      : condition.observable.kind === 'bars'
        ? 'bars:volume_ratio'
        : 'mark';
  const measured = observed === null ? 'unmeasured' : `observed ${observed}`;
  return `${condition.id} (${kind} ${condition.comparator} ${condition.threshold}) ${state}, ${measured}`;
}

/**
 * Every `breached` condition on a verdict. Empty for an absent verdict, an
 * absent list, or an entry that is not a well-formed `EvaluatedCondition`.
 *
 * The last clause is not defensive decoration. `RiskCriticVerdict` is a public
 * seam fed by a SQLite column and by callers this module does not control, and
 * a `[{"state":"breached"}]` payload with no measurement behind it must not
 * reach a hard reject. Only a fully-formed, measured entry has teeth.
 */
export function breachedConditions(
  verdict: RiskCriticVerdict | undefined,
): readonly EvaluatedCondition[] {
  return (verdict?.conditions ?? []).filter(
    (evaluated) => isEvaluatedCondition(evaluated) && evaluated.state === 'breached',
  );
}

/**
 * The audit lines `evaluate()` records for the invalidation half.
 *
 * Pushed BEFORE the prose branch acts, so the condition states and every drop
 * reason land on `RiskDecision.reasons` on every path — a clean pass, a prose
 * trim, a prose reject that returns early, and a breach reject alike. Ordering
 * then decides only which `binding_constraint` wins, never what is recorded.
 */
export function invalidationReasons(verdict: RiskCriticVerdict): string[] {
  const reasons: string[] = [];
  // Every field read below is `bounded()`-ed rather than trusted: these two
  // lists can arrive from a hand-written or corrupted `risk_critic_log` row,
  // and a reason line must never be the thing that throws inside `evaluate()`
  for (const dropped of verdict.dropped_conditions ?? []) {
    const entry = (dropped ?? {}) as Partial<DroppedCondition>;
    reasons.push(
      `risk_critic: dropped condition ${entry.id ?? '<no id>'} (${entry.reason ?? 'unparseable'}): ${bounded(entry.raw)}`,
    );
  }

  const conditions = (verdict.conditions ?? []).filter(isEvaluatedCondition);
  if (conditions.length === 0) {
    reasons.push(NO_CONDITIONS_REASON);
    return reasons;
  }

  reasons.push(
    `risk_critic: conditions — ${conditions.map((evaluated) => describeCondition(evaluated)).join('; ')}`,
  );
  return reasons;
}
