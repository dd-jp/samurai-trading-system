import {
  type Bar,
  computeIndicator,
  type IndicatorSpec,
  minimumBarsFor,
  recommendedWarmupFor,
} from '../../providers/market-data-service/index.js';
import {
  describeThrown,
  describeThrownSafely,
  type ExitReason,
  heldQuantitiesFor,
  type LotHeldQuantity,
  type OpenPosition,
  type OrderIntent,
  type TradingArm,
  totalHeldQuantity,
} from '../../shared/index.js';
import type { DebateResult } from '../debate-engine/index.js';
import { BookValuationError } from '../risk-manager/index.js';
import { priceBracket, sideFor, sizeBracket, type TradeDirection } from './build-bracket.js';
import { NO_PRECEDENT_MULTIPLIER, retrieveCosinePrecedent } from './cosine-precedent.js';
import { readSignalDecay } from './early-exit.js';
import {
  computeFlattenIdempotencyKey,
  computeIdempotencyKey,
  intentSideFor,
} from './idempotency-key.js';
import { buildSetupVector } from './setup-vector.js';
import { resolveSubclassBracket } from './subclass-bracket.js';
import type {
  AssetClass,
  TraderDiagnosticKind,
  TraderInput,
  TraderReasonDetail,
  TraderSkipReason,
} from './types.js';

type HeldLots = [OpenPosition, ...OpenPosition[]];

export function hasLots(positions: OpenPosition[]): positions is HeldLots {
  return positions.length > 0;
}

export function mostRecentOpenLot(positions: readonly OpenPosition[]): OpenPosition {
  return positions.reduce((latest, lot) => (lot.opened_at > latest.opened_at ? lot : latest));
}

export function atrIndicatorSpec(lookback: number, timeframe: string): IndicatorSpec {
  const floor: IndicatorSpec = {
    indicator: 'atr',
    params: { period: lookback },
    timeframe,
    lookback: lookback + 1,
  };
  return { ...floor, lookback: recommendedWarmupFor(floor) };
}

function atrFor(
  bars: Bar[],
  lookback: number,
  timeframe: string,
):
  | { atr: number; reason: null; reason_detail: null }
  | { atr: null; reason: TraderSkipReason; reason_detail: TraderReasonDetail | null } {
  const spec = atrIndicatorSpec(lookback, timeframe);

  const minimumBars = minimumBarsFor(spec);
  if (bars.length < minimumBars) {
    return {
      atr: null,
      reason: 'atr_insufficient_bars',
      reason_detail: { compared_value: bars.length, threshold: minimumBars },
    };
  }

  const atr = computeIndicator(bars, spec);
  return Number.isFinite(atr)
    ? { atr, reason: null, reason_detail: null }
    : { atr: null, reason: 'atr_not_finite', reason_detail: null };
}

type FlattenWindowVerdict =
  | { within: true; enforcing_close: Date; diagnostic: TraderDiagnostic | null }
  | { within: false; enforcing_close: null; diagnostic: TraderDiagnostic | null };

function withinFlattenWindow(
  input: Pick<TraderInput, 'clock' | 'config' | 'sessionCalendars'>,
  assetClass: AssetClass,
): FlattenWindowVerdict {
  if (!(input.config.flatten_before_close_ms > 0)) {
    throw new Error(
      `flatten_before_close_ms must be > 0 (got ${input.config.flatten_before_close_ms}); ` +
        `a non-positive window disables flat-by-close, which ADR-0014 requires`,
    );
  }
  if (!(input.config.flatten_after_close_ms > 0)) {
    throw new Error(
      `flatten_after_close_ms must be > 0 (got ${input.config.flatten_after_close_ms}); ` +
        'a non-positive grace restores the forward-only flatten window #1389 removed',
    );
  }

  const calendar = input.sessionCalendars[assetClass];
  const now = input.clock.now();
  const sessionEnd = calendar.sessionEnd(now);

  if (sessionEnd === null) {
    return {
      within: false,
      enforcing_close: null,
      diagnostic:
        assetClass === 'crypto'
          ? null
          : {
              kind: 'session_end_absent_on_non_crypto',
              asset_class: assetClass,
              detail:
                `${assetClass} calendar returned no session end at ${now.toISOString()}; ` +
                'flat-by-close cannot be enforced for this leg while that persists',
            },
    };
  }

  const remaining = sessionEnd.getTime() - now.getTime();

  if (remaining <= input.config.flatten_before_close_ms) {
    return { within: true, enforcing_close: sessionEnd, diagnostic: null };
  }

  const priorClose = calendar.sessionStart(now);
  const elapsed = now.getTime() - priorClose.getTime();
  if (elapsed >= 0 && elapsed <= input.config.flatten_after_close_ms) {
    return { within: true, enforcing_close: priorClose, diagnostic: null };
  }

  return { within: false, enforcing_close: null, diagnostic: null };
}

function decisionBarFor(debate: DebateResult): Date {
  return debate.bar_timestamp;
}

export function isBookValuationRefusal(error: unknown): boolean {
  return (
    error instanceof BookValuationError ||
    (error instanceof AggregateError &&
      error.errors.length > 0 &&
      error.errors.every((member: unknown) => member instanceof BookValuationError))
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: sequential skip-guard chain (valuation, conviction, flatten window, ATR, mark, sizing) with each guard's position relative to the others explicitly documented and load-bearing; extracting risks silently reordering a guard
async function buildBracket(
  input: TraderInput,
  direction: TradeDirection,
  intentType: 'entry' | 'scale_in',
  diagnostics: TraderDiagnostic[],
): Promise<RoutedOutcome> {
  const { clock, config, debate, instrument, marketData, setupStore } = input;
  const arm = input.arm ?? 'live';

  let equity: number;
  try {
    equity = await input.equity();
  } catch (error) {
    if (arm === 'control' && isBookValuationRefusal(error)) {
      diagnostics.push({
        kind: 'control_arm_valuation_refused',
        asset_class: undefined,
        detail:
          `${instrument}: the control arm could not value the book (${describeThrown(error)}) ` +
          'and skipped this pass instead of crashing it.',
      });
      return skip('control_arm_valuation_refused');
    }
    throw error;
  }

  if (debate.confidence < config.conviction_floor) {
    return skip('below_conviction_floor', {
      compared_value: debate.confidence,
      threshold: config.conviction_floor,
    });
  }

  const asOf = clock.now();
  const [mark, bars] = await Promise.all([
    marketData.getMark(instrument, asOf),
    marketData.getBars(
      instrument,
      {
        timeframe: config.atr_timeframe,
        lookback: recommendedWarmupFor(atrIndicatorSpec(config.atr_lookback, config.atr_timeframe)),
      },
      asOf,
    ),
  ]);

  const flattenWindow = withinFlattenWindow(input, mark.asset_class);
  if (flattenWindow.diagnostic !== null) diagnostics.push(flattenWindow.diagnostic);
  if (flattenWindow.within) {
    return skip('session_closing');
  }

  const atrResult = atrFor(bars, config.atr_lookback, config.atr_timeframe);
  if (atrResult.atr === null) {
    if (atrResult.reason === 'atr_not_finite') {
      diagnostics.push({
        kind: 'atr_not_finite',
        asset_class: mark.asset_class,
        detail:
          `ATR over ${config.atr_lookback} ${config.atr_timeframe} bars for ${instrument} ` +
          'was not finite on a full window — the bar data is corrupt, not merely short',
      });
    }
    return skip(atrResult.reason, atrResult.reason_detail);
  }
  const atr = atrResult.atr;

  const entry = mark.price;
  if (!Number.isFinite(entry)) return skip('mark_not_finite');

  const bracket = resolveSubclassBracket(instrument, config.subclass_of, config.subclass_brackets);

  const priced = priceBracket({ direction, entry, atr, bracket, config });
  if (priced.priced === null) return skip(priced.skip.reason, priced.skip.reason_detail);
  const { side, stop, target, stop_distance: stopDistance } = priced.priced;

  const setupVector = buildSetupVector(debate, { entry, atr, stopDistance, bars });
  const precedent = retrieveCosinePrecedent(setupVector, setupStore, asOf);

  const sized = sizeBracket({
    priced: priced.priced,
    entry,
    equity,
    conviction: debate.confidence,
    converged: debate.converged,
    cosine_multiplier: precedent.cosine_multiplier,
    bracket,
    asset_class: mark.asset_class,
    config,
  });
  if (sized.sized === null) return skip(sized.skip.reason, sized.skip.reason_detail);

  setupStore.writeSetup(debate.debate_id, setupVector, asOf);

  const decisionBar = decisionBarFor(debate);

  return emit(
    {
      idempotency_key: computeIdempotencyKey(
        instrument,
        decisionBar,
        intentSideFor(intentType),
        arm,
      ),
      instrument,
      asset_class: mark.asset_class,
      side,
      intent_type: intentType,
      size: sized.sized.size,
      entry,
      stop,
      target,
      time_in_force: config.time_in_force[mark.asset_class],
      decision_timestamp: decisionBar,
      decided_at: asOf,
      metadata: {
        debate_id: debate.debate_id,
        arm,
        conviction: debate.confidence,
        converged: debate.converged,
        sizing: sized.sized.sizing,
        cosine_precedent: {
          neighbor_count: precedent.neighbor_count,
          weighted_mean_r: precedent.weighted_mean_r,
          no_precedent: precedent.no_precedent,
        },
      },
    },
    atr,
  );
}

async function buildExitIntent(
  input: TraderInput,
  positions: HeldLots,
  exitKind: ExitKind,
): Promise<RoutedOutcome> {
  const { debate } = input;
  return buildFlattenExit(
    input,
    positions,
    decisionBarFor(debate),
    {
      debate_id: debate.debate_id,
      conviction: debate.confidence,
      converged: debate.converged,
    },
    exitKind,
  );
}

interface ExitAttribution {
  debate_id: string;
  conviction: number;
  converged: boolean;
}

async function readExitPrice(
  input: Pick<TraderInput, 'instrument' | 'marketData' | 'onUnpricedFlatten'>,
  lotAssetClass: AssetClass,
  exitReason: ExitReason,
  asOf: Date,
): Promise<{ price: number; asset_class: AssetClass; unpriced: boolean }> {
  const { instrument, marketData } = input;
  try {
    const mark = await marketData.getMark(instrument, asOf);
    return { price: mark.price, asset_class: mark.asset_class, unpriced: false };
  } catch (error) {
    if (exitReason !== 'flatten') throw error;

    const reason = describeThrownSafely(error);
    try {
      input.onUnpricedFlatten?.({ instrument, reason });
    } catch {}
    return { price: 0, asset_class: lotAssetClass, unpriced: true };
  }
}

type ExitKind =
  | { reason: 'flatten'; session_close: Date }
  | { reason: 'signal_decay' }
  | { reason: 'direction_flip' };

async function flattenAlreadyInFlight(
  input: Pick<TraderInput, 'instrument' | 'unresolvedFlattens'>,
): Promise<boolean> {
  const unresolved = await input.unresolvedFlattens();
  return unresolved.some((submission) => submission.instrument === input.instrument);
}

function flattenExitIdempotencyKey(
  instrument: string,
  decisionBar: Date,
  exitKind: ExitKind,
  arm: TradingArm,
): string {
  if (exitKind.reason === 'flatten') {
    return computeFlattenIdempotencyKey(instrument, exitKind.session_close, arm);
  }
  return computeIdempotencyKey(
    instrument,
    decisionBar,
    exitKind.reason === 'signal_decay' ? 'early_close' : 'close',
    arm,
  );
}

function buildFlattenExitMetadata(
  attribution: ExitAttribution,
  arm: TradingArm,
  exitReason: ExitReason,
  unpriced: boolean,
  held: readonly LotHeldQuantity[],
): OrderIntent['metadata'] {
  return {
    debate_id: attribution.debate_id,
    arm,
    exit_reason: exitReason,
    ...(unpriced ? { unpriced_exit: true as const } : {}),
    ...(exitReason === 'flatten' ? { mandatory_flatten: true as const } : {}),
    lot_held_quantities: held,
    conviction: attribution.conviction,
    converged: attribution.converged,
    sizing: {
      base_risk_fraction: 0,
      conviction_multiplier: 0,
      vol_floor_factor: 1,
      non_converged_haircut: 1,
      cosine_multiplier: NO_PRECEDENT_MULTIPLIER,
    },
    cosine_precedent: {
      neighbor_count: 0,
      weighted_mean_r: null,
      no_precedent: true,
    },
  };
}

async function buildFlattenExit(
  input: Pick<
    TraderInput,
    'arm' | 'clock' | 'config' | 'exitFillSizes' | 'instrument' | 'marketData' | 'onUnpricedFlatten'
  >,
  positions: HeldLots,
  decisionBar: Date,
  attribution: ExitAttribution,
  exitKind: ExitKind,
): Promise<RoutedOutcome> {
  const exitReason: ExitReason = exitKind.reason;
  const { clock, config, exitFillSizes, instrument } = input;
  const arm = input.arm ?? 'live';

  const [firstLot] = positions;
  const closingSide = firstLot.side === 'buy' ? 'sell' : 'buy';
  const held = await heldQuantitiesFor(positions, exitFillSizes);

  if (held.some((lot) => lot.held < 0)) return skip('exit_held_quantity_diverged');

  const totalSize = totalHeldQuantity(held);
  if (totalSize <= 0) return skip('exit_no_filled_size');

  const asOf = clock.now();
  const priced = await readExitPrice(input, firstLot.asset_class, exitReason, asOf);

  return emit(
    {
      idempotency_key: flattenExitIdempotencyKey(instrument, decisionBar, exitKind, arm),
      instrument,
      asset_class: priced.asset_class,
      side: closingSide,
      intent_type: 'exit',
      size: totalSize,
      entry: priced.price,
      stop: priced.price,
      target: priced.price,
      time_in_force: config.time_in_force[priced.asset_class],
      decision_timestamp: decisionBar,
      decided_at: asOf,
      metadata: buildFlattenExitMetadata(attribution, arm, exitReason, priced.unpriced, held),
    },
    null,
  );
}

type TraderDecisionClass = 'declined_on_signal' | 'could_not_decide' | 'input_unusable';

const SKIP_REASON_CLASS: Record<TraderSkipReason, TraderDecisionClass> = {
  below_conviction_floor: 'declined_on_signal',
  session_closing: 'declined_on_signal',
  below_min_notional: 'declined_on_signal',
  scale_in_conviction_delta_not_met: 'declined_on_signal',
  rounds_to_zero_shares: 'declined_on_signal',
  no_open_position: 'declined_on_signal',
  signal_still_supports_position: 'declined_on_signal',
  neutral_direction_while_flat: 'declined_on_signal',
  holding_neutral_or_non_converged: 'declined_on_signal',
  exit_no_filled_size: 'input_unusable',
  exit_held_quantity_diverged: 'input_unusable',
  flatten_in_flight: 'declined_on_signal',
  early_exit_signal_unavailable: 'input_unusable',
  atr_insufficient_bars: 'input_unusable',
  atr_not_finite: 'input_unusable',
  mark_not_finite: 'input_unusable',
  stop_distance_not_positive: 'input_unusable',
  size_not_finite: 'input_unusable',
  control_arm_valuation_refused: 'input_unusable',
};

function debateWasDegraded(debate: DebateResult): boolean {
  return !debate.read || debate.timed_out !== undefined || debate.rate_limited !== undefined;
}

const DECLINED_ON_SIGNAL_NOT_DEBATE_DERIVED: ReadonlySet<TraderSkipReason> = new Set([
  'session_closing',
]);

function classifyDecision(
  skip_reason: TraderSkipReason,
  debate: DebateResult,
): TraderDecisionClass {
  const baseClass = SKIP_REASON_CLASS[skip_reason];
  const isDebateDerivedDecline =
    baseClass === 'declined_on_signal' && !DECLINED_ON_SIGNAL_NOT_DEBATE_DERIVED.has(skip_reason);
  return isDebateDerivedDecline && debateWasDegraded(debate) ? 'could_not_decide' : baseClass;
}

export interface TraderDiagnostic {
  kind: TraderDiagnosticKind;
  asset_class: AssetClass | undefined;
  detail: string;
}

export interface TraderOutcome {
  intent: OrderIntent | null;
  skip_reason: TraderSkipReason | null;
  decision_class: TraderDecisionClass | null;
  reason_detail: TraderReasonDetail | null;
  atr: number | null;
  diagnostics: readonly TraderDiagnostic[];
}

type RoutedOutcome = Omit<TraderOutcome, 'decision_class' | 'diagnostics'>;

function skip(
  reason: TraderSkipReason,
  reason_detail: TraderReasonDetail | null = null,
): RoutedOutcome {
  return { intent: null, skip_reason: reason, reason_detail, atr: null };
}

function emit(intent: OrderIntent, atr: number | null): RoutedOutcome {
  return { intent, skip_reason: null, reason_detail: null, atr };
}

function classifiedOutcome(
  outcome: RoutedOutcome,
  classify: (skip_reason: TraderSkipReason) => TraderDecisionClass,
  diagnostics: readonly TraderDiagnostic[],
): TraderOutcome {
  return {
    intent: outcome.intent,
    skip_reason: outcome.skip_reason,
    decision_class: outcome.skip_reason === null ? null : classify(outcome.skip_reason),
    reason_detail: outcome.reason_detail,
    atr: outcome.atr,
    diagnostics,
  };
}

export async function decide(input: TraderInput): Promise<OrderIntent | null> {
  return (await decideWithReason(input)).intent;
}

export async function decideWithReason(input: TraderInput): Promise<TraderOutcome> {
  const diagnostics: TraderDiagnostic[] = [];
  const outcome = await routeDecision(input, diagnostics);
  return classifiedOutcome(
    outcome,
    (skip_reason) => classifyDecision(skip_reason, input.debate),
    diagnostics,
  );
}

function entryFromFlat(
  input: TraderInput,
  diagnostics: TraderDiagnostic[],
): RoutedOutcome | Promise<RoutedOutcome> {
  const { direction } = input.debate;
  if (direction === 'neutral') return skip('neutral_direction_while_flat');
  return buildBracket(input, direction, 'entry', diagnostics);
}

async function routeDecision(
  input: TraderInput,
  diagnostics: TraderDiagnostic[],
): Promise<RoutedOutcome> {
  const { instrument, positionState } = input;

  const positions = (await positionState()).filter((lot) => lot.instrument === instrument);

  if (!hasLots(positions)) return entryFromFlat(input, diagnostics);

  const [{ side: existingSide, asset_class: positionAssetClass }] = positions;

  const flattenWindow = withinFlattenWindow(input, positionAssetClass);
  if (flattenWindow.diagnostic !== null) diagnostics.push(flattenWindow.diagnostic);
  if (flattenWindow.within) {
    if (await flattenAlreadyInFlight(input)) return skip('flatten_in_flight');
    return buildExitIntent(input, positions, {
      reason: 'flatten',
      session_close: flattenWindow.enforcing_close,
    });
  }

  return routeHeldOutsideFlattenWindow(input, positions, existingSide, diagnostics);
}

async function routeHeldOutsideFlattenWindow(
  input: TraderInput,
  positions: HeldLots,
  existingSide: OpenPosition['side'],
  diagnostics: TraderDiagnostic[],
): Promise<RoutedOutcome> {
  const { config, debate } = input;

  if (debate.direction === 'neutral' || !debate.converged) {
    return skip('holding_neutral_or_non_converged');
  }

  const desiredSide = sideFor(debate.direction);
  if (desiredSide !== existingSide) {
    return buildExitIntent(input, positions, { reason: 'direction_flip' });
  }

  const mostRecentLot = mostRecentOpenLot(positions);
  if (debate.confidence - mostRecentLot.conviction < config.scale_in_conviction_delta) {
    return skip('scale_in_conviction_delta_not_met', {
      compared_value: debate.confidence - mostRecentLot.conviction,
      threshold: config.scale_in_conviction_delta,
    });
  }

  return buildBracket(input, debate.direction, 'scale_in', diagnostics);
}

export type ExitCheckInput = Pick<
  TraderInput,
  | 'trace_id'
  | 'instrument'
  | 'clock'
  | 'config'
  | 'marketData'
  | 'sessionCalendars'
  | 'positionState'
  | 'exitFillSizes'
  | 'unresolvedFlattens'
  | 'onUnpricedFlatten'
  | 'arm'
> & {
  bar: Date;
};

export async function checkExitsWithReason(input: ExitCheckInput): Promise<TraderOutcome> {
  const diagnostics: TraderDiagnostic[] = [];
  const outcome = await routeExitCheck(input, diagnostics);
  return classifiedOutcome(outcome, (skip_reason) => SKIP_REASON_CLASS[skip_reason], diagnostics);
}

type ExitPositionContext = {
  positions: HeldLots;
  existingSide: OpenPosition['side'];
  positionAssetClass: AssetClass;
};

async function resolveExitPositionContext(
  input: ExitCheckInput,
): Promise<{ ok: true; context: ExitPositionContext } | { ok: false; outcome: RoutedOutcome }> {
  const { instrument, positionState } = input;

  const positions = (await positionState()).filter((lot) => lot.instrument === instrument);
  if (!hasLots(positions)) return { ok: false, outcome: skip('no_open_position') };

  const [{ side: existingSide, asset_class: positionAssetClass }] = positions;
  return { ok: true, context: { positions, existingSide, positionAssetClass } };
}

async function routeExitCheck(
  input: ExitCheckInput,
  diagnostics: TraderDiagnostic[],
): Promise<RoutedOutcome> {
  const { instrument } = input;

  const resolved = await resolveExitPositionContext(input);
  if (!resolved.ok) return resolved.outcome;
  const { positions, existingSide, positionAssetClass } = resolved.context;

  const flattenWindow = withinFlattenWindow(input, positionAssetClass);
  if (flattenWindow.diagnostic !== null) diagnostics.push(flattenWindow.diagnostic);

  const mostRecentLot = mostRecentOpenLot(positions);
  const attribution = {
    debate_id: mostRecentLot.debate_id,
    conviction: mostRecentLot.conviction,
    converged: mostRecentLot.converged,
  };

  if (flattenWindow.within) {
    if (await flattenAlreadyInFlight(input)) return skip('flatten_in_flight');
    return buildFlattenExit(input, positions, input.bar, attribution, {
      reason: 'flatten',
      session_close: flattenWindow.enforcing_close,
    });
  }

  const decay = await readSignalDecay({
    instrument,
    side: existingSide,
    marketData: input.marketData,
    asOf: input.clock.now(),
    config: input.config.early_exit,
  });
  if (decay.verdict === 'signal_unavailable') return skip('early_exit_signal_unavailable');
  if (decay.verdict === 'holds') return skip('signal_still_supports_position');

  return buildFlattenExit(input, positions, input.bar, attribution, { reason: 'signal_decay' });
}
