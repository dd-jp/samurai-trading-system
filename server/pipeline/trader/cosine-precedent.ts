/**
 * Cosine precedent retrieval + sizing bound (ticket #75).
 * See docs/specs/trader-spec.md "Module: Cosine Precedent Retrieval" and
 * "Cosine Precedent" user stories (12-16). Feeds
 * `OrderIntentMetadata.sizing.cosine_multiplier` /
 * `OrderIntentMetadata.cosine_precedent` in the Trader's sizing pipeline
 * (#73) — not wired in here, since #73 is not yet implemented.
 */
import type { SetupNeighbor, SetupStore, SetupVector } from '../../shared/index.js';

/** Nearest neighbors considered, after the similarity threshold filter. */
export const K_NEIGHBORS = 5;

/** Minimum cosine similarity for a past setup to count as a precedent. */
export const MIN_SIMILARITY_THRESHOLD = 0.75;

/** Fewer qualifying neighbors than this triggers the no-precedent default. */
export const MIN_NEIGHBOR_COUNT = 1;

/** 0.75x default when there is no close neighbor (trader-spec story 15). */
export const NO_PRECEDENT_MULTIPLIER = 0.75;

/** Bounded multiplier range (trader-spec story 14). */
export const MIN_MULTIPLIER = 0.5;
export const MAX_MULTIPLIER = 1.5;

/** Weighted-mean-R magnitude at which the multiplier saturates to the bound. */
export const R_SATURATION = 2;

export interface CosinePrecedentResult {
  cosine_multiplier: number;
  neighbor_count: number;
  weighted_mean_r: number | null;
  no_precedent: boolean;
}

/** Cosine similarity of two equal-length vectors; 0 if either is a zero vector. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('cosineSimilarity: vector length mismatch');
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function toFlatVector(vector: SetupVector): number[] {
  return [...vector.debate_features, ...vector.market_features];
}

/**
 * Maps the similarity-weighted mean R of the retrieved neighbors to a
 * bounded multiplier: 0 -> 1.0x, saturating to MIN/MAX_MULTIPLIER at
 * +-R_SATURATION (trader-spec: "positive -> up, negative -> down, near-zero
 * -> 1.0x").
 */
function rToMultiplier(weightedMeanR: number): number {
  const midpoint = (MIN_MULTIPLIER + MAX_MULTIPLIER) / 2;
  const halfRange = (MAX_MULTIPLIER - MIN_MULTIPLIER) / 2;
  const clampedR = Math.max(-R_SATURATION, Math.min(R_SATURATION, weightedMeanR));
  const multiplier = midpoint + (clampedR / R_SATURATION) * halfRange;
  return Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, multiplier));
}

/**
 * Retrieves the k nearest closed setups above the similarity threshold and
 * derives the bounded (0.5x-1.5x) sizing multiplier from their
 * similarity-weighted mean R-multiple. Falls back to the 0.75x
 * no-precedent default when fewer than `MIN_NEIGHBOR_COUNT` neighbors
 * qualify (trader-spec stories 13-15) — this also covers cold-start/warm-up
 * (an empty store) naturally, with no special-casing (story 26).
 *
 * `store.findNeighbors` is expected to already restrict to setups closed
 * with a known outcome as of `asOf` (point-in-time, no lookahead).
 */
export function retrieveCosinePrecedent(
  target: SetupVector,
  store: SetupStore,
  asOf: Date,
): CosinePrecedentResult {
  const candidates: SetupNeighbor[] = store.findNeighbors(target, asOf);
  const targetFlat = toFlatVector(target);

  const qualifying = candidates
    .map((candidate) => ({
      similarity: cosineSimilarity(targetFlat, toFlatVector(candidate.vector)),
      r_multiple: candidate.r_multiple,
    }))
    .filter((candidate) => candidate.similarity >= MIN_SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, K_NEIGHBORS);

  if (qualifying.length < MIN_NEIGHBOR_COUNT) {
    return {
      cosine_multiplier: NO_PRECEDENT_MULTIPLIER,
      neighbor_count: 0,
      weighted_mean_r: null,
      no_precedent: true,
    };
  }

  const totalWeight = qualifying.reduce((sum, candidate) => sum + candidate.similarity, 0);
  const weightedMeanR =
    qualifying.reduce((sum, candidate) => sum + candidate.similarity * candidate.r_multiple, 0) /
    totalWeight;

  return {
    cosine_multiplier: rToMultiplier(weightedMeanR),
    neighbor_count: qualifying.length,
    weighted_mean_r: weightedMeanR,
    no_precedent: false,
  };
}
