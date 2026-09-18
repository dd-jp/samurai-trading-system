import type { SetupNeighbor, SetupStore, SetupVector } from '../../shared/index.js';

export const K_NEIGHBORS = 5;

export const MIN_SIMILARITY_THRESHOLD = 0.75;

const MIN_NEIGHBOR_COUNT = 1;

export const NO_PRECEDENT_MULTIPLIER = 0.75;

export const MIN_MULTIPLIER = 0.5;
export const MAX_MULTIPLIER = 1.5;

const R_SATURATION = 2;

export interface CosinePrecedentResult {
  cosine_multiplier: number;
  neighbor_count: number;
  weighted_mean_r: number | null;
  no_precedent: boolean;
}

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

function rToMultiplier(weightedMeanR: number): number {
  const midpoint = (MIN_MULTIPLIER + MAX_MULTIPLIER) / 2;
  const halfRange = (MAX_MULTIPLIER - MIN_MULTIPLIER) / 2;
  const clampedR = Math.max(-R_SATURATION, Math.min(R_SATURATION, weightedMeanR));
  const multiplier = midpoint + (clampedR / R_SATURATION) * halfRange;
  return Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, multiplier));
}

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
