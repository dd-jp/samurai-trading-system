import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

export function tradingCalendar(from: string, sessions: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  while (dates.length < sessions) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export interface SyntheticSeriesOptions {
  readonly symbol: string;
  readonly calendar: readonly string[];
  readonly seed: number;
  readonly drift?: number;
  readonly volatility?: number;
  readonly startPrice?: number;
  readonly from?: number;
  readonly to?: number;
  readonly splitAt?: { readonly index: number; readonly ratio: number };
}

export function syntheticSeries(options: SyntheticSeriesOptions): BarSeries {
  const random = seededRandom(options.seed);
  const drift = options.drift ?? 0.0003;
  const volatility = options.volatility ?? 0.015;
  const from = options.from ?? 0;
  const to = options.to ?? options.calendar.length;
  let close = options.startPrice ?? 100;
  let splitFactor = options.splitAt?.ratio ?? 1;
  const bars: DailyBar[] = [];
  for (let index = from; index < to; index++) {
    const shock = gaussian(random) * volatility + drift;
    const open = close * (1 + gaussian(random) * volatility * 0.3);
    close = close * (1 + shock);
    const high = Math.max(open, close) * (1 + Math.abs(gaussian(random)) * volatility * 0.5);
    const low = Math.min(open, close) * (1 - Math.abs(gaussian(random)) * volatility * 0.5);
    if (options.splitAt !== undefined && index >= options.splitAt.index) splitFactor = 1;
    bars.push({
      date: options.calendar[index] as string,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: 1_000_000,
      rawClose: round(close * splitFactor),
    });
  }
  return { symbol: options.symbol, bars };
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), Number.EPSILON);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
