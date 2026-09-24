export interface LossBudgetSteps {
  readonly halfSizeAtGbp: number;
  readonly quarterSizeAtGbp: number;
  readonly haltAtGbp: number;
}

export const LOSS_BUDGET_STEPS: LossBudgetSteps = {
  halfSizeAtGbp: 500,
  quarterSizeAtGbp: 1_000,
  haltAtGbp: 1_500,
};

export const DAILY_CAP_FRACTION_OF_START_CAPITAL = 0.01;

export type SizeMultiplier = 0 | 0.25 | 0.5 | 1;

export function sizeMultiplierFor(
  ytdLossGbp: number,
  steps: LossBudgetSteps = LOSS_BUDGET_STEPS,
): SizeMultiplier {
  assertAscending(steps);
  if (ytdLossGbp >= steps.haltAtGbp) return 0;
  if (ytdLossGbp >= steps.quarterSizeAtGbp) return 0.25;
  if (ytdLossGbp >= steps.halfSizeAtGbp) return 0.5;
  return 1;
}

export function dailyCapBreached(
  dayLossGbp: number,
  startCapitalGbp: number,
  fraction: number = DAILY_CAP_FRACTION_OF_START_CAPITAL,
): boolean {
  if (!(startCapitalGbp > 0)) {
    throw new Error(`dailyCapBreached: startCapitalGbp must be > 0 (got ${startCapitalGbp})`);
  }
  return dayLossGbp >= fraction * startCapitalGbp;
}

export interface LossBudgetState {
  readonly referenceEquityGbp: number;
  readonly ytdLossGbp: number;
  readonly sizeMultiplier: SizeMultiplier;
  readonly halted: boolean;
  readonly entriesBlockedAtNextFill: boolean;
}

export class LossBudget {
  private referenceEquityGbp: number;
  private halted = false;

  constructor(
    private readonly startCapitalGbp: number,
    private readonly steps: LossBudgetSteps = LOSS_BUDGET_STEPS,
    private readonly dailyCapFraction: number = DAILY_CAP_FRACTION_OF_START_CAPITAL,
  ) {
    if (!(startCapitalGbp > 0)) {
      throw new Error(`LossBudget: startCapitalGbp must be > 0 (got ${startCapitalGbp})`);
    }
    assertAscending(steps);
    this.referenceEquityGbp = startCapitalGbp;
  }

  resetYear(equityAtYearStartGbp: number): void {
    this.referenceEquityGbp = equityAtYearStartGbp;
    this.halted = false;
  }

  markClose(equityGbp: number, previousCloseEquityGbp: number): LossBudgetState {
    const ytdLossGbp = this.referenceEquityGbp - equityGbp;
    const multiplier = sizeMultiplierFor(ytdLossGbp, this.steps);
    if (multiplier === 0) this.halted = true;
    const capBreached = dailyCapBreached(
      previousCloseEquityGbp - equityGbp,
      this.startCapitalGbp,
      this.dailyCapFraction,
    );
    return {
      referenceEquityGbp: this.referenceEquityGbp,
      ytdLossGbp,
      sizeMultiplier: this.halted ? 0 : multiplier,
      halted: this.halted,
      entriesBlockedAtNextFill: this.halted || capBreached,
    };
  }
}

function assertAscending(steps: LossBudgetSteps): void {
  if (
    !(steps.halfSizeAtGbp > 0) ||
    !(steps.quarterSizeAtGbp > steps.halfSizeAtGbp) ||
    !(steps.haltAtGbp > steps.quarterSizeAtGbp)
  ) {
    throw new Error(
      `LossBudgetSteps must satisfy 0 < half < quarter < halt (got ${JSON.stringify(steps)})`,
    );
  }
}
