import type { DateRange } from './universe.js';
import type { MinBtlVerdict, PboVerdict } from './validation-types.js';

const EULER_MASCHERONI = 0.5772156649015329;

const PBO_REJECT_THRESHOLD = 0.05;

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export function windowYears(window: DateRange): number {
  return (window.end.getTime() - window.start.getTime()) / MS_PER_YEAR;
}

export const MINBTL_TARGET_ANNUAL_SHARPE = 1;

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

function expectedMaxOfNSharpes(nTrials: number, sampleLen: number): number {
  if (nTrials === 1) {
    return 0;
  }

  const sharpeStdev = Math.sqrt(1 / sampleLen);
  const term =
    (1 - EULER_MASCHERONI) * inverseNormalCdf(1 - 1 / nTrials) +
    EULER_MASCHERONI * inverseNormalCdf(1 - 1 / (nTrials * Math.E));

  return sharpeStdev * term;
}

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

function minimumBacktestLengthYears(nTrials: number, expectedAnnualSharpe: number): number {
  if (nTrials <= 1) {
    return 0;
  }

  const term =
    (1 - EULER_MASCHERONI) * inverseNormalCdf(1 - 1 / nTrials) +
    EULER_MASCHERONI * inverseNormalCdf(1 - 1 / (nTrials * Math.E));

  return term ** 2 / expectedAnnualSharpe ** 2;
}

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

function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new Error(`inverseNormalCdf: p must be in (0, 1) (got ${p}).`);
  }

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

function scores(row: readonly number[], folds: readonly number[]): number[] {
  return folds.map((fold) => at(row, fold));
}

function at(values: readonly number[], index: number): number {
  const value = values[index];

  if (value === undefined) {
    throw new Error(`pbo: no score at index ${index} of a ${values.length}-entry row.`);
  }

  return value;
}

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
