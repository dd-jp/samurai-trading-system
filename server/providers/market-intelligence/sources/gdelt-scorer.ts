/**
 * GDELT GKG scoring — the derivation half of #556, built by #1086.
 *
 * ## What this is
 *
 * A PURE function over archived rows. `GdeltIngestAgent` stores the vendor's
 * six-column projection and nothing else; this module turns a slice of that
 * archive into at most one `IntelligenceItem` per asset class per window, by
 * comparing the mean tone of a 1-hour signal window against the mean tone of
 * the trailing 24-hour baseline behind it.
 *
 * Purity is the load-bearing property, not a style preference. #556 point 3
 * decided the aggregates are derived at READ rather than stored at ingest,
 * precisely so the window and baseline lengths stay changeable retroactively
 * over history already collected. That only holds if the derivation is a
 * function of (rows, window spec) with no clock, no store and no I/O in it —
 * which is also what makes replaying one archive twice produce byte-identical
 * items (#1086 AC2).
 *
 * ## Scoring is mechanical, and `f` is explicitly a placeholder
 *
 * `sentiment = sign(toneDelta)` and `confidence = f(|toneDelta|)` — no LLM, no
 * per-row call, no spend. `f` is `confidenceFromToneDelta` below, and #688
 * owns its calibration. What is pinned here (and in `gdelt-scorer.test.ts`)
 * are its PROPERTIES, not its shape: bounded to [0, 1], monotone
 * non-decreasing in `|toneDelta|`, zero at zero, and pure. Any curve meeting
 * those four may replace the current one without touching a caller. No
 * expectancy claim rests on the particular curve.
 *
 * ## Vendor tone is a feature, never ground truth (#556 point 4)
 *
 * The score is the DELTA against the trailing baseline, not the tone level.
 * A wire whose absolute tone runs permanently negative is a level, not news;
 * what moves is the change. The tone mean itself is carried alongside in
 * `GdeltAggregateStats` and in the item's summary so a reader can see the
 * level the delta was taken from, but nothing keys off it.
 *
 * ## Minimum baseline coverage
 *
 * `gdelt-ingest-agent.ts`'s header states the hazard: a partial baseline is
 * worse than none, because a large `toneDelta` measured off ninety minutes of
 * history lands as a HIGH-confidence signal built out of nothing. Three rules
 * gate emission, each catching a failure the others cannot see:
 *
 *  1. **Far end populated** — the OLDEST bucket of the baseline must carry a
 *     record. This is the cold-start rule: it is the only one that proves the
 *     archive leads the signal by a full baseline window. A density rule alone
 *     would emit at hour 18 of a fresh archive, which is exactly what the
 *     archive/scoring split exists to prevent. Same shape as
 *     `polymarket-agent.ts`'s `BASELINE_TOLERANCE_MS`, which refuses unless
 *     its baseline point sits within tolerance of a full 24h ago.
 *  2. **Bucket coverage** — at least `MIN_BASELINE_BUCKET_FRACTION` of the
 *     baseline's buckets populated. This catches a GAP: a fetcher outage in
 *     the middle of the window leaves a baseline whose record count looks
 *     healthy but whose mean describes a different eighteen hours than the
 *     window claims.
 *  3. **Record density** — at least `MIN_BASELINE_RECORDS_PER_BUCKET` records
 *     per bucket on average. This catches THINNESS: a mean of one article an
 *     hour is a sample, not a baseline, and rule 2 cannot see it because every
 *     bucket is technically populated.
 *
 * A thin SIGNAL window is a separate reason (`signal_window_thin`) rather than
 * a fourth coverage rule, because it is a different fact about the world: a
 * quiet hour is normal and self-correcting, while a cold or gapped baseline is
 * an ingestion problem. `gdelt-scoring-pass.ts` logs the two at different
 * levels for that reason.
 *
 * Both floors are stated per BUCKET, not as absolute counts, so changing the
 * baseline length re-derives coherently over the same archive — the AC3
 * property. An absolute "48 records" would silently become a 4x stricter rule
 * on a 6-hour baseline.
 */

import type { AssetClass } from '../../../shared/index.js';
import type { RawArchiveRow } from '../archive/mi-archive-store.js';
import { MI_SOURCES } from '../archive/mi-sources.js';
import type { IntelligenceItem } from '../types.js';
import { themesFor } from './gdelt-themes.js';

/**
 * Field offsets INTO THE STORED PROJECTION, not into the GKG line.
 * `gdelt-gkg-client.ts` writes `PROJECTED_COLUMNS.map(...).join('\t')`, so the
 * archive holds six fields in file order: recordId, date, sourceName,
 * documentUrl, themes, tone.
 */
const PROJECTED = { themes: 4, tone: 5 } as const;

/** Milliseconds of the signal window and of the baseline behind it. */
export interface GdeltWindows {
  signalWindowMs: number;
  baselineWindowMs: number;
}

/** #556 point 1: a 1-hour signal window against a trailing 24-hour baseline. */
export const DEFAULT_GDELT_WINDOWS: GdeltWindows = {
  signalWindowMs: 60 * 60 * 1000,
  baselineWindowMs: 24 * 60 * 60 * 1000,
};

/**
 * `f`'s half-confidence point, in GKG tone units.
 *
 * A tone delta of this size scores `confidence = 0.5`. One tone point is a
 * large move on a scale whose macro readings sit within a few points of zero,
 * so this is a deliberately conservative placeholder rather than a measured
 * value — #688 owns replacing it, and its calibration must not be read off
 * this constant.
 */
export const CONFIDENCE_HALF_POINT_TONE = 1;

/** Fraction of the baseline's buckets that must carry at least one record. */
export const MIN_BASELINE_BUCKET_FRACTION = 0.75;

/** Mean records per baseline bucket below which the baseline is a sample, not a level. */
export const MIN_BASELINE_RECORDS_PER_BUCKET = 2;

/** Records the signal window must carry before its mean is worth a delta. */
export const MIN_SIGNAL_RECORDS = 5;

/**
 * The macro series name every GDELT item is filed under.
 *
 * NOT a ticker, and that is the decision rather than an omission. GDELT items
 * are class-wide macro aggregates: filing them under 3USL/3LDE/SGLN would
 * clear `MiCoverageMonitor`'s per-ticker check (`hasCoverageFor` matches
 * `entity === instrument`) without telling any analyst one thing about the
 * ticker — the same metric-gaming `polymarket-agent.ts` refuses by filing
 * under macro series names. `IntelligenceItem.scope` is what carries these to
 * an entity-scoped read instead.
 */
export const GDELT_MACRO_ENTITY = 'GDELT-MACRO';

/** Why a window produced no item. Each maps to one rule in this module's header. */
export type GdeltRefusalReason =
  | 'baseline_far_end_empty'
  | 'baseline_too_sparse'
  | 'signal_window_thin';

/** What the derivation measured, emitted or not — the operator-facing numbers. */
export interface GdeltAggregateStats {
  signal_records: number;
  baseline_records: number;
  baseline_buckets: number;
  baseline_buckets_populated: number;
  /** `undefined` when the window held no parseable record. */
  signal_tone_mean: number | undefined;
  baseline_tone_mean: number | undefined;
  tone_delta: number | undefined;
}

export type GdeltDerivation =
  | { emitted: true; item: IntelligenceItem; stats: GdeltAggregateStats }
  | { emitted: false; reason: GdeltRefusalReason; stats: GdeltAggregateStats };

export interface GdeltDeriveParams {
  asset_class: AssetClass;
  /**
   * The exclusive end of the signal window — the debate bar's open time. Both
   * windows sit strictly BEFORE it, so the derivation reads only closed time
   * and cannot move within a bar.
   */
  windowEnd: Date;
  windows?: GdeltWindows;
}

/** Themes and average tone out of one stored projection, or undefined when unusable. */
export function parseGdeltProjection(
  payload: string,
): { themes: string[]; tone: number } | undefined {
  const fields = payload.split('\t');
  const themes = (fields[PROJECTED.themes] ?? '').split(';').filter((theme) => theme.length > 0);
  // V1.5TONE is `tone,positive,negative,polarity,…`; only the first field is
  // the average tone #556 scores on.
  const tone = Number.parseFloat((fields[PROJECTED.tone] ?? '').split(',')[0] ?? '');
  if (!Number.isFinite(tone)) return undefined;
  return { themes, tone };
}

/**
 * `f`: |toneDelta| -> confidence. A placeholder with pinned properties; #688 calibrates it.
 *
 * `d / (d + k)` is bounded by construction (the numerator is always the
 * smaller term), monotone in `d`, zero at zero, and saturating rather than
 * stepped — the shape the spec asks for and the two it bars (a step function,
 * an unbounded linear map) are neither.
 */
export function confidenceFromToneDelta(toneDelta: number): number {
  const magnitude = Math.abs(toneDelta);
  if (!Number.isFinite(magnitude)) return 1;
  return magnitude / (magnitude + CONFIDENCE_HALF_POINT_TONE);
}

/** `-0` is a real value here, so the comparisons are explicit rather than `Math.sign`. */
function signOf(toneDelta: number): 1 | 0 | -1 {
  if (toneDelta > 0) return 1;
  if (toneDelta < 0) return -1;
  return 0;
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Derives at most one class-wide macro aggregate from archived GKG rows.
 *
 * Rows outside the two windows are ignored, so a caller may pass a wider slice
 * than it needs; rows at or after `windowEnd` are ignored too, which is what
 * keeps the open bar out of the read.
 */
export function deriveGdeltAggregate(
  rows: readonly RawArchiveRow[],
  params: GdeltDeriveParams,
): GdeltDerivation {
  const windows = params.windows ?? DEFAULT_GDELT_WINDOWS;
  const windowEnd = params.windowEnd.getTime();
  const signalStart = windowEnd - windows.signalWindowMs;
  const baselineStart = signalStart - windows.baselineWindowMs;
  const buckets = Math.ceil(windows.baselineWindowMs / windows.signalWindowMs);
  const watched = new Set(themesFor(params.asset_class));

  const signalTones: number[] = [];
  const baselineTones: number[] = [];
  const populated = new Set<number>();

  for (const raw of rows) {
    const at = raw.updated_at.getTime();
    if (at < baselineStart || at >= windowEnd) continue;
    const parsed = parseGdeltProjection(raw.payload);
    if (parsed === undefined) continue;
    // The fetcher filters against the UNION of both legs' watchlists; which
    // leg a row belongs to is decided here, where `themesFor` is the
    // authority (`gdelt-themes.ts`).
    if (!parsed.themes.some((theme) => watched.has(theme))) continue;

    if (at >= signalStart) {
      signalTones.push(parsed.tone);
      continue;
    }
    baselineTones.push(parsed.tone);
    populated.add(Math.floor((at - baselineStart) / windows.signalWindowMs));
  }

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

  // Rule 1 first: a cold archive is the case where the other two numbers are
  // most misleading, because the window they describe never existed.
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
    return { emitted: false, reason: 'signal_window_thin', stats };
  }

  const toneDelta = stats.tone_delta;
  const sentiment = signOf(toneDelta);
  const direction = sentiment === 1 ? 'improving' : sentiment === -1 ? 'deteriorating' : 'flat';
  const hours = (ms: number): string => `${(ms / (60 * 60 * 1000)).toFixed(0)}h`;

  const item: IntelligenceItem = {
    // Deterministic in (source, class, window end): replaying the same archive
    // derives the same id, so `MarketIntelligenceStore.ingest`'s dedupe makes a
    // repeat within one bar a no-op rather than a second vote.
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
      `(delta ${toneDelta.toFixed(2)}), over ${signalTones.length} signal and ` +
      `${baselineTones.length} baseline records across ${populated.size}/${buckets} populated ` +
      'buckets. Vendor tone is a feature, not ground truth: the delta is the signal, the level ' +
      'is context.',
  };

  return { emitted: true, item, stats };
}
