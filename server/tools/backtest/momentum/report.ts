import type { PassResult, VenueData } from './run.js';
import { annualisedSharpe, maxDrawdown } from './stats.js';
import type { TrialSummary } from './verdict.js';

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const num = (value: number, digits = 3): string =>
  Number.isFinite(value) ? value.toFixed(digits) : String(value);

export function renderVerdictMarkdown(
  data: Pick<
    VenueData,
    | 'venue'
    | 'missingCoverageFraction'
    | 'missingNames'
    | 'spreadFallbackBps'
    | 'spreadMeasuredNames'
  >,
  passes: readonly PassResult[],
): string {
  const lines: string[] = [`# Momentum sub-book verdict: ${data.venue.toUpperCase()}`, ''];
  const first = passes[0];
  if (first !== undefined) {
    lines.push(
      `Evaluated ${first.verdict.evaluatedFrom} to ${first.verdict.evaluatedTo} ` +
        `(${first.verdict.evaluatedYears.toFixed(2)} years), ${first.verdict.trialsCounted} trials counted (Grid A), ` +
        `MinBTL limit at Sharpe 0.6: ${first.verdict.minbtl.limit} (${first.verdict.minbtl.exceeded ? 'exceeded' : 'within'}).`,
      '',
    );
  }
  if (data.venue === 'us') {
    lines.push(
      `US coverage: ${data.missingNames.length} point-in-time constituents without bars (${pct(data.missingCoverageFraction)}); ` +
        `2% stop ${data.missingCoverageFraction > 0.02 ? 'FAILED' : 'within'}; 0.05 Sharpe delisting haircut applied. ` +
        `Half-spread measured for ${data.spreadMeasuredNames} names, fallback median ${num(data.spreadFallbackBps, 2)} bps for the rest.`,
      '',
    );
    if (data.missingNames.length > 0) lines.push(`Missing: ${data.missingNames.join(', ')}`, '');
  }
  for (const pass of passes) lines.push(...renderPass(pass));
  return `${lines.join('\n')}\n`;
}

function renderPass(pass: PassResult): string[] {
  const { verdict } = pass;
  const mode = pass.wholeShares ? 'whole shares' : 'fractional';
  const lines = [
    `## £${pass.startCapitalGbp} start capital, ${mode}: ${verdict.pass ? 'PASS' : 'FAIL'}`,
    '',
    `Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.`,
    '',
    `| Check | Value | Result |`,
    `| --- | --- | --- |`,
    `| Walk-forward strategy Sharpe | ${num(verdict.walkForward.strategySharpe)} | |`,
    `| minus delisting haircut ${num(verdict.delistingHaircutApplied, 2)} | ${num(verdict.walkForward.strategySharpeAfterDelistingHaircut)} | |`,
    `| × 0.6 haircut | ${num(verdict.walkForward.strategySharpeHaircut)} | ${verdict.checks.beatsBenchmarkAfterHaircut ? 'beats' : 'does not beat'} |`,
    `| Benchmark Sharpe (same window, fractional, same budget rules) | ${num(verdict.walkForward.benchmarkSharpe)} | |`,
    `| DSR (selected trial #${verdict.selectedTrial}, N=${verdict.trialsCounted}) | ${num(verdict.deflatedSharpe)} | ${verdict.checks.dsrAtLeast095 ? '>= 0.95' : '< 0.95'} |`,
    `| DSR (walk-forward path) | ${num(verdict.deflatedSharpeWalkForward)} | |`,
    `| PBO (CSCV, 16 folds) | ${num(verdict.pbo)} | ${verdict.checks.pboAtMost010 ? '<= 0.10' : '> 0.10'} |`,
    `| Coverage stop | ${pct(verdict.missingCoverageFraction)} missing | ${verdict.checks.coverageWithinStop ? 'within 2%' : 'FAILED'} |`,
    `| Walk-forward max drawdown (strategy / benchmark) | ${pct(verdict.walkForward.strategyMaxDrawdown)} / ${pct(verdict.walkForward.benchmarkMaxDrawdown)} | |`,
    `| Capital ceiling £1,500 / (selected max DD × 1.5) | £${num(verdict.capitalCeilingGbp, 0)} | |`,
    '',
    `Walk-forward window ${verdict.walkForward.from} to ${verdict.walkForward.to}; trial selected per fold: ${verdict.walkForward.selectedByFold.join(', ')}.`,
    '',
    `| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const trial of verdict.trials) lines.push(trialRow(`#${trial.trial}`, trial));
  lines.push(trialRow('benchmark (fractional)', verdict.benchmark));
  lines.push(
    `| benchmark (${mode}) | ${num(annualisedSharpe(pass.benchmarkSameMode.returns))} | | | ${pct(maxDrawdown(pass.benchmarkSameMode.equity))} | ${num(pass.benchmarkSameMode.equity[pass.benchmarkSameMode.equity.length - 1] as number, 0)} | ${pass.benchmarkSameMode.fills.length} | | ${pass.benchmarkSameMode.skippedFills} | ${pass.benchmarkSameMode.zeroShareTargets} | ${num(pass.benchmarkSameMode.totalCost, 0)} | |`,
    '',
  );
  return lines;
}

function trialRow(label: string, trial: Omit<TrialSummary, 'trial' | 'hash'>): string {
  const budget = trial.budgetDays;
  return (
    `| ${label} | ${num(trial.sharpe)} | ${pct(trial.annualReturn)} | ${pct(trial.annualVol)} | ${pct(trial.maxDrawdown)} | ` +
    `${num(trial.finalEquity, 0)} | ${trial.fills} | ${trial.stopHits} | ${trial.skippedFills} | ${trial.zeroShareTargets} | ` +
    `${num(trial.totalCost, 0)} | ${budget.half}/${budget.quarter}/${budget.halted}/${budget.capBlocked} |`
  );
}
