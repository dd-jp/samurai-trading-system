import type { DailyBar } from '../../pipeline/momentum/index.js';
import type { AlpacaBarsApi, RawDailyBar } from './alpaca-bars-api.js';

export function barDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

export function joinAdjustedAndRaw(
  symbol: string,
  adjusted: readonly RawDailyBar[],
  raw: readonly RawDailyBar[],
): DailyBar[] {
  const rawClose = new Map(raw.map((bar) => [barDate(bar.t), bar.c]));
  return adjusted.map((bar) => {
    const date = barDate(bar.t);
    const close = rawClose.get(date);
    if (close === undefined) {
      throw new Error(`${symbol}: adjusted bar ${date} has no raw counterpart`);
    }
    return {
      date,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
      rawClose: close,
    };
  });
}

export function alpacaSymbolCandidates(ticker: string): readonly string[] {
  return ticker.includes('.') ? [ticker, ticker.replace('.', '')] : [ticker];
}

export async function pullSymbol(
  api: AlpacaBarsApi,
  ticker: string,
  start: string,
  end: string,
): Promise<{ alpacaSymbol: string; bars: DailyBar[] } | undefined> {
  for (const alpacaSymbol of alpacaSymbolCandidates(ticker)) {
    const adjusted = await api.dailyBars({ symbol: alpacaSymbol, start, end, adjustment: 'all' });
    if (adjusted.length === 0) continue;
    const raw = await api.dailyBars({ symbol: alpacaSymbol, start, end, adjustment: 'raw' });
    return { alpacaSymbol, bars: joinAdjustedAndRaw(ticker, adjusted, raw) };
  }
  return undefined;
}
