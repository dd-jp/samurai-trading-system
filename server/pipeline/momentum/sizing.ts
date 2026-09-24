export const TRADING_DAYS_PER_YEAR = 252;
export const WHOLE_SHARE_TOLERANCE_MULTIPLE = 5;

export function wholeShares(cash: number, rawPrice: number): number {
  if (!(rawPrice > 0) || !(cash > 0)) return 0;
  return Math.floor(cash / rawPrice);
}

export function adjustedQuantity(shares: number, rawPrice: number, adjustedPrice: number): number {
  if (!(adjustedPrice > 0) || !(rawPrice > 0)) {
    throw new Error(
      `adjustedQuantity: prices must be > 0 (raw ${rawPrice}, adjusted ${adjustedPrice})`,
    );
  }
  return (shares * rawPrice) / adjustedPrice;
}

export function withinWholeShareTolerance(
  rawPrice: number,
  capital: number,
  holdings: number,
): boolean {
  if (!(holdings >= 1))
    throw new Error(`withinWholeShareTolerance: holdings must be >= 1 (got ${holdings})`);
  return rawPrice <= capital / (WHOLE_SHARE_TOLERANCE_MULTIPLE * holdings);
}

export function annualisedVolatility(dailyReturns: readonly number[]): number {
  if (dailyReturns.length < 2) {
    throw new Error(`annualisedVolatility: need >= 2 returns (got ${dailyReturns.length})`);
  }
  let sum = 0;
  for (const value of dailyReturns) sum += value;
  const mean = sum / dailyReturns.length;
  let squares = 0;
  for (const value of dailyReturns) squares += (value - mean) ** 2;
  return Math.sqrt(squares / (dailyReturns.length - 1)) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

export function inverseVolatilityWeights(
  volatilities: ReadonlyMap<string, number>,
  targetVolatility: number,
  grossCap: number,
): Map<string, number> {
  if (!(targetVolatility > 0)) {
    throw new Error(
      `inverseVolatilityWeights: targetVolatility must be > 0 (got ${targetVolatility})`,
    );
  }
  const weights = new Map<string, number>();
  let gross = 0;
  for (const [symbol, volatility] of volatilities) {
    if (!(volatility > 0)) continue;
    const weight = targetVolatility / volatility;
    weights.set(symbol, weight);
    gross += weight;
  }
  return capGross(weights, gross, grossCap);
}

export function equalWeights(symbols: readonly string[], grossCap: number): Map<string, number> {
  const weights = new Map<string, number>();
  if (symbols.length === 0) return weights;
  for (const symbol of symbols) weights.set(symbol, grossCap / symbols.length);
  return weights;
}

function capGross(
  weights: Map<string, number>,
  gross: number,
  grossCap: number,
): Map<string, number> {
  if (!(grossCap > 0)) throw new Error(`grossCap must be > 0 (got ${grossCap})`);
  if (gross <= grossCap) return weights;
  const scale = grossCap / gross;
  for (const [symbol, weight] of weights) weights.set(symbol, weight * scale);
  return weights;
}
