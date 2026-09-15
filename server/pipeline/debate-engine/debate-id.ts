/**
 * Deterministic debate_id computation — see docs/specs/debate-engine-spec.md
 * (DebateLog, "Debate log write") and docs/specs/cross-spec-contracts.md
 * registry #1. Load-bearing join key for Trader/Verdict provenance, the
 * cosine setup-store join, and the Feedback Loop's debate-log attribution
 * join, so it must be stable across the no-persistence re-run-from-scratch
 * (decision #10): identical (instrument, bar, AnalystView set) must hash to
 * the same id even after a crash restarts the debate from nothing.
 */
import { createHash } from 'node:crypto';
import type { AnalystView } from './types.js';

/**
 * Fields excluded from the hash because they vary across an otherwise
 * identical re-run: `trace_id` is a correlation id tied to the invocation,
 * not business data, and `timestamp` is the wall-clock moment the view was
 * produced, not the view's content
 */
function normalizeView(view: AnalystView) {
  return {
    analyst_id: view.analyst_id,
    analyst_type: view.analyst_type,
    direction: view.direction,
    confidence: view.confidence,
    key_points: view.key_points,
  };
}

/**
 * Computes debate_id = hash(instrument + bar + AnalystView set). The
 * AnalystView collection is a set, not a sequence — views are sorted by
 * analyst_id before hashing so analysts responding in a different order
 * across runs does not change the id.
 */
export function computeDebateId(instrument: string, bar: Date, views: AnalystView[]): string {
  const normalized = views
    .map(normalizeView)
    .sort((a, b) => a.analyst_id.localeCompare(b.analyst_id));

  const payload = JSON.stringify({
    instrument,
    bar: bar.toISOString(),
    views: normalized,
  });

  return createHash('sha256').update(payload).digest('hex');
}
