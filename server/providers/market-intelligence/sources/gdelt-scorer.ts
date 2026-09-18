
import type { AssetClass } from '../../../shared/index.js';
import type { RawArchiveRow } from '../archive/mi-archive-store.js';
import { MI_SOURCES } from '../archive/mi-sources.js';
import type { IntelligenceItem } from '../types.js';
import { themesFor } from './gdelt-themes.js';

const PROJECTED = { themes: 4, tone: 5 } as const;

export interface GdeltWindows {
  signalWindowMs: number;
  baselineWindowMs: number;
}

export const DEFAULT_GDELT_WINDOWS: GdeltWindows = {
  signalWindowMs: 60 * 60 * 1000,
  baselineWindowMs: 24 * 60 * 60 * 1000,
};

const CONFIDENCE_HALF_POINT_TONE = 1;

export const MIN_BASELINE_BUCKET_FRACTION = 0.75;

export const MIN_BASELINE_RECORDS_PER_BUCKET = 2;

export const MIN_SIGNAL_RECORDS = 5;

export const GDELT_MACRO_ENTITY = 'GDELT-MACRO';

export type GdeltRefusalReason =
  | 'baseline_far_end_empty'
  | 'baseline_too_sparse'
  | 'signal_window_thin';

interface GdeltAggregateStats {
  signal_records: number;
  baseline_records: number;
  baseline_buckets: number;
  baseline_buckets_populated: number;
  signal_tone_mean: number | undefined;
  baseline_tone_mean: number | undefined;
  tone_delta: number | undefined;
}

export type GdeltDerivation =
  | { emitted: true; item: IntelligenceItem; stats: GdeltAggregateStats }
  | { emitted: false; reason: GdeltRefusalReason; stats: GdeltAggregateStats };

export interface GdeltDeriveParams {
  asset_class: AssetClass;
  windowEnd: Date;
  windows?: GdeltWindows;
}

export function parseGdeltProjection(
  payload: string,
): { themes: string[]; tone: number } | undefined {
  const fields = payload.split('\t');
  const themes = (fields[PROJECTED.themes] ?? '').split(';').filter((theme) => theme.length > 0);
  const tone = Number.parseFloat((fields[PROJECTED.tone] ?? '').split(',')[0] ?? '');
  if (!Number.isFinite(tone)) return undefined;
  return { themes, tone };
}

export function confidenceFromToneDelta(toneDelta: number): number {
  const magnitude = Math.abs(toneDelta);
  if (!Number.isFinite(magnitude)) return 1;
  return magnitude / (magnitude + CONFIDENCE_HALF_POINT_TONE);
}

function signOf(toneDelta: number): 1 | 0 | -1 {
  if (toneDelta > 0) return 1;
  if (toneDelta < 0) return -1;
  return 0;
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

interface GdeltWindowTones {
  signalTones: number[];
  baselineTones: number[];
  populated: Set<number>;
}

function collectGdeltWindowTones(
  rows: readonly RawArchiveRow[],
  asset_class: AssetClass,
  baselineStart: number,
  signalStart: number,
  windowEnd: number,
  signalWindowMs: number,
): GdeltWindowTones {
  const watched = new Set(themesFor(asset_class));
  const signalTones: number[] = [];
  const baselineTones: number[] = [];
  const populated = new Set<number>();

  for (const raw of rows) {
    const at = raw.updated_at.getTime();
    if (at < baselineStart || at >= windowEnd) continue;
    const parsed = parseGdeltProjection(raw.payload);
    if (parsed === undefined) continue;
    if (!parsed.themes.some((theme) => watched.has(theme))) continue;

    if (at >= signalStart) {
      signalTones.push(parsed.tone);
      continue;
    }
    baselineTones.push(parsed.tone);
    populated.add(Math.floor((at - baselineStart) / signalWindowMs));
  }

  return { signalTones, baselineTones, populated };
}

function buildGdeltItem(
  params: GdeltDeriveParams,
  windows: GdeltWindows,
  toneDelta: number,
  signalMean: number,
  baselineMean: number,
  signalRecords: number,
  baselineRecords: number,
  populatedBuckets: number,
  buckets: number,
): IntelligenceItem {
  const sentiment = signOf(toneDelta);
  const direction = sentiment === 1 ? 'improving' : sentiment === -1 ? 'deteriorating' : 'flat';
  const hours = (ms: number): string => `${(ms / (60 * 60 * 1000)).toFixed(0)}h`;

  return {
    id: `${MI_SOURCES.gdeltGkg}:${params.asset_class}:${params.windowEnd.toISOString()}`,
    source: MI_SOURCES.gdeltGkg,
    type: 'news',
    timestamp: params.windowEnd,
    entity: GDELT_MACRO_ENTITY,
    scope: 'asset_class',
    headline: `GDELT macro tone ${direction} (${toneDelta >= 0 ? '+' : ''}${toneDelta.toFixed(2)} vs ${hours(windows.baselineWindowMs)} baseline)`,
    sentiment,
    confidence: confidenceFromToneDelta(toneDelta),
    summary:
      `${hours(windows.signalWindowMs)} mean tone ${signalMean.toFixed(2)} against a trailing ` +
      `${hours(windows.baselineWindowMs)} baseline mean of ${baselineMean.toFixed(2)} ` +
      `(delta ${toneDelta.toFixed(2)}), over ${signalRecords} signal and ` +
      `${baselineRecords} baseline records across ${populatedBuckets}/${buckets} populated ` +
      'buckets. Vendor tone is a feature, not ground truth: the delta is the signal, the level ' +
      'is context.',
  };
}

export function deriveGdeltAggregate(
  rows: readonly RawArchiveRow[],
  params: GdeltDeriveParams,
): GdeltDerivation {
  const windows = params.windows ?? DEFAULT_GDELT_WINDOWS;
  const windowEnd = params.windowEnd.getTime();
  const signalStart = windowEnd - windows.signalWindowMs;
  const baselineStart = signalStart - windows.baselineWindowMs;
  const buckets = Math.ceil(windows.baselineWindowMs / windows.signalWindowMs);

  const { signalTones, baselineTones, populated } = collectGdeltWindowTones(
    rows,
    params.asset_class,
    baselineStart,
    signalStart,
    windowEnd,
    windows.signalWindowMs,
  );

  const signalMean = mean(signalTones);
  const baselineMean = mean(baselineTones);
  const stats: GdeltAggregateStats = {
    signal_records: signalTones.length,
    baseline_records: baselineTones.length,
    baseline_buckets: buckets,
    baseline_buckets_populated: populated.size,
    signal_tone_mean: signalMean,
    baseline_tone_mean: baselineMean,
    tone_delta:
      signalMean === undefined || baselineMean === undefined
        ? undefined
        : signalMean - baselineMean,
  };

  if (!populated.has(0)) return { emitted: false, reason: 'baseline_far_end_empty', stats };
  if (
    populated.size < Math.ceil(buckets * MIN_BASELINE_BUCKET_FRACTION) ||
    baselineTones.length < buckets * MIN_BASELINE_RECORDS_PER_BUCKET
  ) {
    return { emitted: false, reason: 'baseline_too_sparse', stats };
  }
  if (signalTones.length < MIN_SIGNAL_RECORDS) {
    return { emitted: false, reason: 'signal_window_thin', stats };
  }
  if (signalMean === undefined || baselineMean === undefined || stats.tone_delta === undefined) {
    throw new Error(
      'deriveGdeltAggregate: coverage rules passed but a window mean is undefined ' +
        `(signal ${signalTones.length} records, baseline ${baselineTones.length})`,
    );
  }

  const item = buildGdeltItem(
    params,
    windows,
    stats.tone_delta,
    signalMean,
    baselineMean,
    signalTones.length,
    baselineTones.length,
    populated.size,
    buckets,
  );

  return { emitted: true, item, stats };
}
