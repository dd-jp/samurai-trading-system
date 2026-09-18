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

export const MAX_INVALIDATION_CONDITIONS = 5;

export const MAX_INSPECTED_CONDITIONS = 16;

export const MAX_INVALIDATION_LOOKBACK = 1000;

export const INVALIDATED_BINDING_CONSTRAINT = 'risk_critic:invalidated';

const MAX_RAW_CHARS = 200;

const COMPARATORS: readonly InvalidationComparator[] = ['<', '<=', '>', '>='];
type Comparator = InvalidationComparator;

const INDICATOR_KIND_SET: ReadonlySet<string> = new Set<string>(INDICATOR_KINDS);

type FalsifyingDirection = 'opposite_side' | 'downward_only';

const INDICATOR_DIRECTION: Partial<Record<IndicatorKind, FalsifyingDirection>> = {
  sma: 'opposite_side',
  ema: 'opposite_side',
  rsi: 'opposite_side',
};

interface ThresholdRange {
  min: number;
  max: number;
  exclusive_min?: boolean;
}

const INDICATOR_RANGE: Partial<Record<IndicatorKind, ThresholdRange>> = {
  rsi: { min: 0, max: 100 },
  adx: { min: 0, max: 100 },
  donchian_pos: { min: 0, max: 1 },
  atr: { min: 0, max: Number.POSITIVE_INFINITY },
  atr_pct: { min: 0, max: Number.POSITIVE_INFINITY },
  bb_kc_squeeze: { min: 0, max: Number.POSITIVE_INFINITY },
};

const MARK_RANGE: ThresholdRange = { min: 0, max: Number.POSITIVE_INFINITY, exclusive_min: true };
const VOLUME_RATIO_RANGE: ThresholdRange = {
  min: 0,
  max: Number.POSITIVE_INFINITY,
  exclusive_min: true,
};

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

export interface ValidatedConditions {
  accepted: InvalidationCondition[];
  dropped: DroppedCondition[];
}

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

export function readPersistedConditions(parsed: unknown): EvaluatedCondition[] | undefined {
  if (!Array.isArray(parsed)) return undefined;
  if (parsed.length === 0) return [];
  const survivors = parsed.filter(isEvaluatedCondition);
  return survivors.length === 0 ? undefined : survivors;
}

export function readPersistedDroppedConditions(parsed: unknown): DroppedCondition[] | undefined {
  return readListStrict(parsed, isDroppedCondition);
}

export interface EvaluateConditionsInput {
  conditions: readonly InvalidationCondition[];
  instrument: string;
  marketData: MarketDataService;
  asOf: Date;
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
  if (!isFiniteNumber(mean) || mean === 0) return null;
  const ratio = latest.volume / mean;
  return isFiniteNumber(ratio) ? ratio : null;
}

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
    return null;
  }
}

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

export function breachedConditions(
  verdict: RiskCriticVerdict | undefined,
): readonly EvaluatedCondition[] {
  return (verdict?.conditions ?? []).filter(
    (evaluated) => isEvaluatedCondition(evaluated) && evaluated.state === 'breached',
  );
}

export function invalidationReasons(verdict: RiskCriticVerdict): string[] {
  const reasons: string[] = [];
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
