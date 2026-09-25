import type { CapitalYear, LossBudgetState, SizeMultiplier } from '../../../../contracts/index.js';

// G6 (4): exactly 1.0% of the year's start capital; D8 keeps it when the cap is re-set
export const DAILY_CAP_FRACTION_OF_START_CAPITAL = 0.01;

export function sizeMultiplierFor(ytdLossGbp: number, lossCapGbp: number): SizeMultiplier {
  if (ytdLossGbp >= lossCapGbp) return 0;
  if (ytdLossGbp >= (lossCapGbp * 2) / 3) return 0.25;
  if (ytdLossGbp >= lossCapGbp / 3) return 0.5;
  return 1;
}

export function dailyCapBreached(dayLossGbp: number, capital: CapitalYear): boolean {
  return dayLossGbp >= DAILY_CAP_FRACTION_OF_START_CAPITAL * capital.startCapitalGbp;
}

export class LossBudget {
  #referenceEquityGbp: number;
  #halted = false;

  constructor(bookStartCapitalGbp: number) {
    if (!(bookStartCapitalGbp > 0)) {
      throw new Error(`LossBudget: start capital must be > 0 (got ${bookStartCapitalGbp})`);
    }
    this.#referenceEquityGbp = bookStartCapitalGbp;
  }

  get referenceEquityGbp(): number {
    return this.#referenceEquityGbp;
  }

  resetYear(equityAtYearStartGbp: number): void {
    this.#referenceEquityGbp = equityAtYearStartGbp;
    this.#halted = false;
  }

  markClose(
    equityGbp: number,
    previousCloseEquityGbp: number,
    capital: CapitalYear,
  ): LossBudgetState {
    const ytdLossGbp = this.#referenceEquityGbp - equityGbp;
    if (sizeMultiplierFor(ytdLossGbp, capital.lossCapGbp) === 0) this.#halted = true;
    const multiplier = this.#halted ? 0 : sizeMultiplierFor(ytdLossGbp, capital.lossCapGbp);
    return {
      referenceEquityGbp: this.#referenceEquityGbp,
      ytdLossGbp,
      sizeMultiplier: multiplier,
      halted: this.#halted,
      entriesBlockedAtNextFill:
        this.#halted || dailyCapBreached(previousCloseEquityGbp - equityGbp, capital),
    };
  }
}
