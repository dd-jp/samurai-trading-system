import {
  type BookSeries,
  capitalCeilingGbp,
  deflatedSharpeOfReturns,
  MIN_DEFLATED_SHARPE,
  SHARPE_HAIRCUT_MULTIPLIER,
  type TrialSeries,
} from './backtest-verdict.js';
import {
  annualisedSharpe,
  foldRanges,
  foldSharpeMatrix,
  maxDrawdown,
  PBO_REJECT_THRESHOLD,
  pbo,
  WALK_FORWARD_FOLDS,
} from './evidence/index.js';

// Doc 66 2026-09-28 (v3 feature evidence): the baseline's path noise, 2 sd of its OOS Sharpe
export const BASELINE_PATH_NOISE_OOS_SHARPE = 0.25;

export interface VolTargetVerdictInput {
  readonly dates: readonly string[];
  readonly trial: TrialSeries;
  readonly baseline: BookSeries;
  readonly outOfSampleFrom: string;
  readonly trialsCounted: number;
  readonly lossCapGbp: number;
  readonly folds?: number | undefined;
  readonly embargo?: number | undefined;
}

export interface ArmSummary {
  readonly sharpeInSample: number;
  readonly sharpeOutOfSample: number;
  readonly maxDrawdown: number;
  readonly maxDrawdownOutOfSample: number;
  readonly totalReturn: number;
  readonly totalReturnOutOfSample: number;
  readonly yearsInsideLossCap: number;
}

export interface VolTargetVerdict {
  readonly from: string;
  readonly to: string;
  readonly outOfSampleFrom: string;
  readonly trial: number;
  readonly trialsCounted: number;
  readonly scaled: ArmSummary;
  readonly baseline: ArmSummary;
  readonly outOfSampleSharpeHaircut: number;
  readonly outOfSampleSharpeDelta: number;
  readonly beyondBaselinePathNoise: boolean;
  readonly deflatedSharpe: number;
  readonly pbo: number;
  readonly capitalCeilingGbp: number;
  readonly checks: {
    readonly beatsBaselineOutOfSampleAfterHaircut: boolean;
    readonly lowersDrawdown: boolean;
    readonly deflatedSharpeAtLeast095: boolean;
    readonly pboAtMost010: boolean;
  };
  readonly pass: boolean;
}

function assertSplit(input: VolTargetVerdictInput, split: number): void {
  const length = input.dates.length;
  for (const series of [input.trial, input.baseline]) {
    if (series.returns.length !== length || series.equity.length !== length + 1) {
      throw new Error('volTargetVerdict: every series must cover the same dates');
    }
  }
  if (split < 2 || length - split < 2) {
    throw new Error(
      `volTargetVerdict: ${input.outOfSampleFrom} leaves fewer than 2 sessions on one side of the split`,
    );
  }
  if (input.trialsCounted < 1) throw new Error('volTargetVerdict: the trial is not counted');
}

export function yearsInsideLossCap(
  dates: readonly string[],
  equity: readonly number[],
  lossCapGbp: number,
): number {
  let reference = equity[0] as number;
  let years = 0;
  let inside = 0;
  dates.forEach((date, index) => {
    if (dates[index + 1]?.slice(0, 4) === date.slice(0, 4)) return;
    const close = equity[index + 1] as number;
    years += 1;
    if (reference - close <= lossCapGbp) inside += 1;
    reference = close;
  });
  return inside / years;
}

function summary(
  series: BookSeries,
  dates: readonly string[],
  split: number,
  lossCapGbp: number,
): ArmSummary {
  const equity = series.equity;
  const outOfSample = equity.slice(split);
  return {
    sharpeInSample: annualisedSharpe(series.returns.slice(0, split)),
    sharpeOutOfSample: annualisedSharpe(series.returns.slice(split)),
    maxDrawdown: maxDrawdown(equity),
    maxDrawdownOutOfSample: maxDrawdown(outOfSample),
    totalReturn: (equity.at(-1) as number) / (equity[0] as number) - 1,
    totalReturnOutOfSample: (outOfSample.at(-1) as number) / (outOfSample[0] as number) - 1,
    yearsInsideLossCap: yearsInsideLossCap(dates, equity, lossCapGbp),
  };
}

// #1860: one counted trial against unscaled arm 2, so CSCV ranks the pair, the only
// configurations the run chooses between
function pairPbo(input: VolTargetVerdictInput): number {
  const ranges = foldRanges(
    input.dates.length,
    input.folds ?? WALK_FORWARD_FOLDS,
    input.embargo ?? 0,
  );
  return pbo(foldSharpeMatrix([input.baseline.returns, input.trial.returns], ranges)).pbo;
}

export function volTargetVerdict(input: VolTargetVerdictInput): VolTargetVerdict {
  const split = input.dates.findIndex((date) => date >= input.outOfSampleFrom);
  assertSplit(input, split);
  const scaled = summary(input.trial, input.dates, split, input.lossCapGbp);
  const baseline = summary(input.baseline, input.dates, split, input.lossCapGbp);
  const haircut = scaled.sharpeOutOfSample * SHARPE_HAIRCUT_MULTIPLIER;
  const delta = scaled.sharpeOutOfSample - baseline.sharpeOutOfSample;
  const dsr = deflatedSharpeOfReturns(input.trial.returns, input.trialsCounted);
  const probability = pairPbo(input);
  const checks = {
    beatsBaselineOutOfSampleAfterHaircut: haircut > baseline.sharpeOutOfSample,
    lowersDrawdown: scaled.maxDrawdown < baseline.maxDrawdown,
    deflatedSharpeAtLeast095: dsr >= MIN_DEFLATED_SHARPE,
    pboAtMost010: probability <= PBO_REJECT_THRESHOLD,
  };
  return {
    from: input.dates[0] as string,
    to: input.dates.at(-1) as string,
    outOfSampleFrom: input.dates[split] as string,
    trial: input.trial.trial,
    trialsCounted: input.trialsCounted,
    scaled,
    baseline,
    outOfSampleSharpeHaircut: haircut,
    outOfSampleSharpeDelta: delta,
    beyondBaselinePathNoise: Math.abs(delta) > BASELINE_PATH_NOISE_OOS_SHARPE,
    deflatedSharpe: dsr,
    pbo: probability,
    capitalCeilingGbp: capitalCeilingGbp(input.lossCapGbp, scaled.maxDrawdown),
    checks,
    pass: Object.values(checks).every(Boolean),
  };
}
