/**
 * The overfitting defences — Deflated Sharpe Ratio, Probability of Backtest
 * Overfitting, and the MinBTL guard (ticket #89). See
 * docs/specs/cost-model-backtest-spec.md ("Module: Validation Library" —
 * DSR / PBO / MinBTL) and user stories 15-17.
 *
 * All three answer the same question from different angles: *how much of this
 * backtest's edge is an artifact of how hard I searched?* They are the
 * enforcement of research Principle 3 (overfitting is the central danger), and
 * they all deflate by **N = distinct configs evaluated for selection**, which
 * `config-trial-log.ts` is what makes real.
 *
 * Sources: Bailey & López de Prado, "The Deflated Sharpe Ratio" (2014) and
 * "The Probability of Backtest Overfitting" (2015); López de Prado, *Advances
 * in Financial Machine Learning*, ch. 8 (MinBTL). Implemented in TypeScript
 * per ADR-0001's "mine for patterns, no hard dependency" reuse posture — see
 * the note in metrics.ts.
 */

import type { DateRange } from './universe.js';
import type { MinBtlVerdict, PboVerdict } from './validation-types.js';

/** Euler–Mascheroni constant, from the expected-maximum-of-N-Gaussians term. */
const EULER_MASCHERONI = 0.5772156649015329;

/** The spec's kill line: "reject if PBO > 0.05". */
const PBO_REJECT_THRESHOLD = 0.05;

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * A window's length in Julian years — the conversion MinBTL's cap is a
 * function of.
 *
 * Exported because `sizeTrialGridToSample` reports the same figure alongside
 * the cap derived from it, and had its own copy of this arithmetic that agreed
 * with this one only by a comment saying so. Two constants that must match is
 * the shape of a bug, not a coincidence worth preserving.
 */
export function windowYears(window: DateRange): number {
  return (window.end.getTime() - window.start.getTime()) / MS_PER_YEAR;
}

/**
 * The annual Sharpe a trial is assumed to be searching for, in the MinBTL
 * cap — E[SR] in López de Prado's formula. **1.0 is a judgement call, not a
 * measurement**: it is López de Prado's reference case, and reproduces the
 * spec's stated calibration exactly (at N = 45 the formula returns ~5 years,
 * the "~45 / 5 yr" the spec and the issue both quote).
 *
 * It is *not* derived from anything this project has measured. The one
 * strategy actually measured under the superseded doc 10 configuration came
 * in at 0.71 (`docs/research/10-edge-hypothesis.md`) — 29% below this
 * constant — and at that value every trial-budget number this project has
 * quoted shrinks by roughly 17x (807 -> 48 at the 10.2y window; see
 * `overfitting.test.ts`'s "E[SR] sensitivity" case for the full table).
 * Whether 1.0 or something else is the right E[SR] to search for is an
 * open call reserved for the repo owner — see
 * https://github.com/dd-jp/samurai-trading-system/issues/637. This constant
 * only fixes the *default*; callers that want to state a different
 * assumption pass `expectedAnnualSharpe` explicitly to `minbtl` /
 * `minbtlGuard`.
 */
export const MINBTL_TARGET_ANNUAL_SHARPE = 1;

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado 2014, eq. 9): the probability
 * that the observed Sharpe exceeds what the *best of N trials* would produce
 * by luck alone, given the sample length and the returns' non-normality.
 *
 *   DSR = Z[ (SR − SR₀)·√(n−1) / √(1 − γ₃·SR + (γ₄−1)/4·SR²) ]
 *
 * Falls as N rises for a fixed Sharpe — that is the entire point, and the
 * mechanism by which "I tried a thousand configs and this one looked great"
 * stops being a selling point.
 *
 * @param perPeriodSharpe The **non-annualized** Sharpe (mean/stdev of the raw
 *   periodic returns). Not `MetricsSuite.sharpe`, which is annualized: the
 *   formula's variance term is defined against the per-period statistic, and
 *   feeding it an annualized value silently inflates the result.
 * @param nDistinctConfigs N — distinct configs evaluated for selection, from
 *   `ConfigTrialLog.distinctTrialCount()`.
 * @param sampleLen Number of return observations.
 * @param skew `MetricsSuite.skew`.
 * @param excessKurtosis `MetricsSuite.kurtosis`, which is **excess** (0 =
 *   normal). Converted to the formula's non-excess γ₄ internally.
 */
export function deflatedSharpe(
  perPeriodSharpe: number,
  nDistinctConfigs: number,
  sampleLen: number,
  skew: number,
  excessKurtosis: number,
): number {
  if (!Number.isInteger(nDistinctConfigs) || nDistinctConfigs < 1) {
    throw new Error(
      `deflatedSharpe: nDistinctConfigs must be an integer >= 1 (got ${nDistinctConfigs}).`,
    );
  }
  if (sampleLen < 2) {
    throw new Error(`deflatedSharpe: sampleLen must be >= 2 (got ${sampleLen}).`);
  }

  const kurtosis = excessKurtosis + 3;
  const expectedMaxSharpe = expectedMaxOfNSharpes(nDistinctConfigs, sampleLen);

  const variance = 1 - skew * perPeriodSharpe + ((kurtosis - 1) / 4) * perPeriodSharpe ** 2;

  if (variance <= 0) {
    throw new Error(
      `deflatedSharpe: the Sharpe estimator's variance term is ${variance.toFixed(4)} (must be > 0). ` +
        'The supplied skew/kurtosis are inconsistent with this Sharpe.',
    );
  }

  const z =
    ((perPeriodSharpe - expectedMaxSharpe) * Math.sqrt(sampleLen - 1)) / Math.sqrt(variance);

  return normalCdf(z);
}

/**
 * SR₀ — the Sharpe the luckiest of N trials reaches by chance (Bailey &
 * López de Prado 2014, eq. 5):
 *
 *   SR₀ = √V · [ (1−γ)·Z⁻¹(1 − 1/N) + γ·Z⁻¹(1 − 1/(N·e)) ]
 *
 * V is the variance of the Sharpes *across* the trials. The spec's signature
 * does not carry it, so this takes the null-hypothesis value: under "no config
 * has real edge", the trial Sharpes differ only by estimation noise, whose
 * variance is 1/sampleLen. That is the assumption the deflation is meant to
 * test against, and it keeps the primitive callable from the seam FL and
 * offline research were given.
 */
function expectedMaxOfNSharpes(nTrials: number, sampleLen: number): number {
  // One trial is no search: nothing to deflate, and Z⁻¹(0) would diverge.
  if (nTrials === 1) {
    return 0;
  }

  const sharpeStdev = Math.sqrt(1 / sampleLen);
  const term =
    (1 - EULER_MASCHERONI) * inverseNormalCdf(1 - 1 / nTrials) +
    EULER_MASCHERONI * inverseNormalCdf(1 - 1 / (nTrials * Math.E));

  return sharpeStdev * term;
}

/**
 * Probability of Backtest Overfitting via CSCV (Bailey & López de Prado 2015):
 * across every symmetric train/test partition of the folds, pick the config
 * that was best in-sample and see where it ranks out-of-sample. PBO is the
 * fraction of partitions where the IS-best config lands below the OOS median —
 * i.e. how often "best in backtest" predicts nothing at all.
 *
 * **Takes a configs x folds matrix, not the spec's `pbo(oosDistribution:
 * number[])`.** That sketched signature cannot satisfy the requirement it sits
 * beneath: PBO is defined in the same spec as "probability the in-sample-best
 * config underperforms the median OOS across CPCV paths", and a single array
 * holds one config's distribution — there is no *ranking across configs* in
 * it, so the number cannot be computed. The matrix is the minimum input the
 * stated definition needs.
 *
 * @param performance `performance[c][f]` = config `c`'s performance (Sharpe,
 *   conventionally) on fold `f`, from the `generateSplits` folds. Needs >= 2
 *   configs (a ranking of one is vacuous) and an even fold count >= 4 (the
 *   partitions are symmetric halves).
 */
export function pbo(performance: readonly (readonly number[])[]): PboVerdict {
  const folds = assertUsableMatrix(performance);

  let underperformed = 0;
  let partitions = 0;

  for (const trainFolds of combinations(folds, folds / 2)) {
    const testFolds = Array.from({ length: folds }, (_, index) => index).filter(
      (index) => !trainFolds.includes(index),
    );

    const best = argMax(performance.map((row) => mean(scores(row, trainFolds))));
    const oos = performance.map((row) => mean(scores(row, testFolds)));
    const bestOos = at(oos, best);

    // Relative rank of the IS-best config within the OOS results: <= 0.5 means
    // it fell at or below the median, i.e. the IS selection was noise.
    const rank = oos.filter((value) => value < bestOos).length / (oos.length - 1);

    if (rank <= 0.5) {
      underperformed++;
    }
    partitions++;
  }

  const probability = underperformed / partitions;

  return {
    pbo: probability,
    verdict: probability > PBO_REJECT_THRESHOLD ? 'reject' : 'accept',
  };
}

/**
 * MinBTL (López de Prado, AFML ch. 8): the maximum number of independent
 * trials a sample of this length can support before an in-sample Sharpe of
 * `expectedAnnualSharpe` is expected to arise from chance alone.
 *
 * Inverted numerically from the minimum-backtest-length formula
 *
 *   MinBTL(N) ≈ [ (1−γ)·Z⁻¹(1 − 1/N) + γ·Z⁻¹(1 − 1/(N·e)) ]² / E[SR]²   years
 *
 * which is strictly increasing in N, so counting upward finds the largest N
 * the window supports. At the default E[SR] = 1.0 the spec's calibration
 * falls straight out: 5 years of data supports ~45 trials.
 *
 * @param expectedAnnualSharpe E[SR] — the annual Sharpe a trial is assumed
 *   to be searching for. Defaults to `MINBTL_TARGET_ANNUAL_SHARPE` (1.0,
 *   López de Prado's reference case). This is a **judgement call reserved
 *   for the repo owner, not a measured constant** — see that constant's doc
 *   comment. The cap is *inversely proportional to the square* of this
 *   value, so a lower E[SR] shrinks the trial budget sharply: at the default
 *   1.0 a 10.2y window supports 807 trials; at the one measured Sharpe this
 *   project has on record, 0.71, the same window supports 48. Every caller
 *   that reports a MinBTL number should state which E[SR] produced it.
 */
export function minbtl(
  window: DateRange,
  expectedAnnualSharpe: number = MINBTL_TARGET_ANNUAL_SHARPE,
): { limit: number } {
  const years = windowYears(window);

  if (years <= 0) {
    throw new Error('minbtl: window must have end > start.');
  }
  if (!(expectedAnnualSharpe > 0)) {
    throw new Error(`minbtl: expectedAnnualSharpe must be > 0 (got ${expectedAnnualSharpe}).`);
  }

  let limit = 1;
  while (minimumBacktestLengthYears(limit + 1, expectedAnnualSharpe) <= years) {
    limit++;
  }

  return { limit };
}

/**
 * The guard (user story 17, and the issue's "rejects a trial count exceeding
 * the cap"): flag when the distinct-config count has out-searched the data.
 *
 * Flags rather than throws. The spec is explicit that "the report flags
 * `exceeded`" — unlike the no-lookahead audit, which fails the run, this is a
 * judgement the caller (FL's kill/rework decision, or a researcher) owns, and
 * an exception here would deny them the report they need in order to make it.
 */
export function minbtlGuard(
  window: DateRange,
  distinctConfigs: number,
  expectedAnnualSharpe: number = MINBTL_TARGET_ANNUAL_SHARPE,
): MinBtlVerdict {
  if (!Number.isInteger(distinctConfigs) || distinctConfigs < 0) {
    throw new Error(
      `minbtlGuard: distinctConfigs must be an integer >= 0 (got ${distinctConfigs}).`,
    );
  }

  const { limit } = minbtl(window, expectedAnnualSharpe);

  return { limit, distinct_configs: distinctConfigs, exceeded: distinctConfigs > limit };
}

/** Years of data N independent trials require. Strictly increasing in N. */
function minimumBacktestLengthYears(nTrials: number, expectedAnnualSharpe: number): number {
  if (nTrials <= 1) {
    return 0;
  }

  const term =
    (1 - EULER_MASCHERONI) * inverseNormalCdf(1 - 1 / nTrials) +
    EULER_MASCHERONI * inverseNormalCdf(1 - 1 / (nTrials * Math.E));

  return term ** 2 / expectedAnnualSharpe ** 2;
}

/** Φ(z), via the Abramowitz & Stegun 7.1.26 error-function approximation. */
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absolute = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * absolute);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absolute * absolute);

  return sign * y;
}

/** Φ⁻¹(p), via Acklam's rational approximation (|error| < 1.15e-9). */
function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new Error(`inverseNormalCdf: p must be in (0, 1) (got ${p}).`);
  }

  // `as const` fixes these as tuples, so the coefficient reads below are
  // statically known to exist rather than `number | undefined`.
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ] as const;
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ] as const;
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ] as const;
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
  ] as const;

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

function argMax(values: readonly number[]): number {
  let best = 0;
  let bestValue = Number.NEGATIVE_INFINITY;

  values.forEach((value, index) => {
    if (value > bestValue) {
      bestValue = value;
      best = index;
    }
  });

  return best;
}

/** One config's scores on the given folds. */
function scores(row: readonly number[], folds: readonly number[]): number[] {
  return folds.map((fold) => at(row, fold));
}

/**
 * Indexed read that states the invariant instead of assuming it.
 * `assertUsableMatrix` has already established every row covers every fold, so
 * a miss here is a bug in this module, not bad input — but silently coercing it
 * to 0 would score a config as mediocre rather than surface the bug.
 */
function at(values: readonly number[], index: number): number {
  const value = values[index];

  if (value === undefined) {
    throw new Error(`pbo: no score at index ${index} of a ${values.length}-entry row.`);
  }

  return value;
}

/** All ascending index combinations of `choose` out of `n`. */
function combinations(n: number, choose: number): number[][] {
  const result: number[][] = [];

  const walk = (start: number, picked: number[]): void => {
    if (picked.length === choose) {
      result.push([...picked]);
      return;
    }
    for (let index = start; index < n; index++) {
      walk(index + 1, [...picked, index]);
    }
  };

  walk(0, []);
  return result;
}

/** @returns the fold count. */
function assertUsableMatrix(performance: readonly (readonly number[])[]): number {
  const [first] = performance;

  if (first === undefined || performance.length < 2) {
    throw new Error(
      `pbo: need >= 2 configs to rank (got ${performance.length}) — PBO measures selection across configs.`,
    );
  }

  const folds = first.length;

  if (folds < 4 || folds % 2 !== 0) {
    throw new Error(
      `pbo: need an even fold count >= 4 (got ${folds}) — CSCV partitions the folds into symmetric halves.`,
    );
  }

  for (const row of performance) {
    if (row.length !== folds) {
      throw new Error(
        `pbo: every config must be scored on the same ${folds} folds (got a row of ${row.length}).`,
      );
    }
  }

  return folds;
}
