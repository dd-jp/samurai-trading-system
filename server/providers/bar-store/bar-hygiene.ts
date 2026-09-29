import type { DailyBar } from '../../pipeline/momentum/index.js';

const UNIT_BREAK_MIN_RATIO = 90;
const UNIT_BREAK_MAX_RATIO = 110;
const HOLE_MIN_RATIO = 3;
const SUSPECT_MIN_RATIO = 1.35;
const GLITCH_RANGE_MAX_RATIO = 1.4;

export interface UnitBreak {
  readonly date: string;
  readonly factor: number;
}

export interface HoleRecord {
  readonly date: string;
  readonly ratio: number;
}

export interface SuspectFlips {
  readonly count: number;
  readonly from: string;
  readonly to: string;
}

export type RescalableField = 'open' | 'high' | 'low';

export interface FieldRescale {
  readonly date: string;
  readonly field: RescalableField;
  readonly factor: 100 | 0.01;
}

export interface ShapeRepairReport {
  readonly rescaled_fields: readonly FieldRescale[];
  readonly dropped_glitch_dates: readonly string[];
  readonly ranges_widened: number;
}

export interface HygieneReport {
  readonly dropped_dates: readonly string[];
  readonly unit_breaks: readonly UnitBreak[];
  readonly holes: readonly HoleRecord[];
  readonly suspect_flips: SuspectFlips | undefined;
}

function isUnitBreakRatio(ratio: number): boolean {
  return (
    (ratio > UNIT_BREAK_MIN_RATIO && ratio < UNIT_BREAK_MAX_RATIO) ||
    (ratio > 1 / UNIT_BREAK_MAX_RATIO && ratio < 1 / UNIT_BREAK_MIN_RATIO)
  );
}

function isHoleRatio(ratio: number): boolean {
  return ratio > HOLE_MIN_RATIO || ratio < 1 / HOLE_MIN_RATIO;
}

function isSuspectRatio(ratio: number): boolean {
  return ratio > SUSPECT_MIN_RATIO || ratio < 1 / SUSPECT_MIN_RATIO;
}

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

export function dropNonSessionBars(
  bars: readonly DailyBar[],
  fetchDate: string,
): { bars: DailyBar[]; dropped: string[] } {
  const dropped: string[] = [];
  const kept = bars.filter((bar) => {
    const drop = isWeekend(bar.date) || bar.date >= fetchDate;
    if (drop) dropped.push(bar.date);
    return !drop;
  });
  return { bars: kept, dropped };
}

export function findUnitBreaks(bars: readonly DailyBar[]): UnitBreak[] {
  const breaks: UnitBreak[] = [];
  for (let index = 1; index < bars.length; index++) {
    const ratio = (bars[index] as DailyBar).close / (bars[index - 1] as DailyBar).close;
    if (isUnitBreakRatio(ratio)) {
      breaks.push({ date: (bars[index] as DailyBar).date, factor: ratio > 1 ? 100 : 0.01 });
    }
  }
  return breaks;
}

function scaleBar(bar: DailyBar, factor: number): DailyBar {
  return {
    date: bar.date,
    open: bar.open * factor,
    high: bar.high * factor,
    low: bar.low * factor,
    close: bar.close * factor,
    volume: bar.volume,
    rawClose: bar.rawClose * factor,
  };
}

export function normaliseUnitBreaks(bars: readonly DailyBar[]): {
  bars: DailyBar[];
  breaks: UnitBreak[];
} {
  const breaks = findUnitBreaks(bars);
  if (breaks.length === 0) return { bars: [...bars], breaks };
  const scaled: DailyBar[] = [];
  let factor = 1;
  let nextBreak = breaks.length - 1;
  for (let index = bars.length - 1; index >= 0; index--) {
    const bar = bars[index] as DailyBar;
    while (nextBreak >= 0 && (breaks[nextBreak] as UnitBreak).date > bar.date) {
      factor *= (breaks[nextBreak] as UnitBreak).factor;
      nextBreak--;
    }
    scaled.push(factor === 1 ? bar : scaleBar(bar, factor));
  }
  return { bars: scaled.reverse(), breaks };
}

type RatioClass = 'unit-break' | 'hole' | 'suspect' | 'ok';

function classifyRatio(ratio: number): RatioClass {
  if (isUnitBreakRatio(ratio)) return 'unit-break';
  if (isHoleRatio(ratio)) return 'hole';
  if (isSuspectRatio(ratio)) return 'suspect';
  return 'ok';
}

function flipsFrom(flipDates: readonly string[]): SuspectFlips | undefined {
  const first = flipDates[0];
  const last = flipDates[flipDates.length - 1];
  return first === undefined || last === undefined
    ? undefined
    : { count: flipDates.length, from: first, to: last };
}

export function findHolesAndFlips(bars: readonly DailyBar[]): {
  holes: HoleRecord[];
  flips: SuspectFlips | undefined;
} {
  const holes: HoleRecord[] = [];
  const flipDates: string[] = [];
  for (let index = 1; index < bars.length; index++) {
    const date = (bars[index] as DailyBar).date;
    const ratio = (bars[index] as DailyBar).close / (bars[index - 1] as DailyBar).close;
    const kind = classifyRatio(ratio);
    if (kind === 'hole') holes.push({ date, ratio });
    else if (kind === 'suspect') flipDates.push(date);
  }
  return { holes, flips: flipsFrom(flipDates) };
}

export function applyBarHygiene(
  tidm: string,
  raw: readonly DailyBar[],
  options: { readonly fetchDate: string; readonly allowHolesReason?: string },
): { bars: DailyBar[]; report: HygieneReport } {
  const sessions = dropNonSessionBars(raw, options.fetchDate);
  const { bars, breaks } = normaliseUnitBreaks(sessions.bars);
  const { holes, flips } = findHolesAndFlips(bars);
  if (holes.length > 0 && options.allowHolesReason === undefined) {
    throw new Error(
      `${tidm}: ${holes.length} close/close ratio(s) beyond ${HOLE_MIN_RATIO}× that are not a unit break (first ${holes[0]?.date} ×${holes[0]?.ratio.toFixed(3)}) — a data hole; refuse to write unless the line is allow-listed with a reason`,
    );
  }
  return {
    bars,
    report: { dropped_dates: sessions.dropped, unit_breaks: breaks, holes, suspect_flips: flips },
  };
}

const PRICE_FIELDS = ['open', 'high', 'low', 'close'] as const;
const RESCALABLE_FIELDS: readonly RescalableField[] = ['open', 'high', 'low'];

function medianOfThree(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

function medianOfOtherPrices(bar: DailyBar, field: RescalableField): number {
  const [a, b, c] = PRICE_FIELDS.filter((other) => other !== field).map((other) => bar[other]) as [
    number,
    number,
    number,
  ];
  return medianOfThree(a, b, c);
}

function fieldUnitFactor(bar: DailyBar, field: RescalableField): 100 | 0.01 | undefined {
  const ratio = bar[field] / medianOfOtherPrices(bar, field);
  if (!isUnitBreakRatio(ratio)) return undefined;
  return ratio > 1 ? 0.01 : 100;
}

function rescaleFields(bar: DailyBar): { bar: DailyBar; rescales: FieldRescale[] } {
  const rescales = RESCALABLE_FIELDS.flatMap((field) => {
    const factor = fieldUnitFactor(bar, field);
    return factor === undefined ? [] : [{ date: bar.date, field, factor }];
  });
  const scaled = Object.fromEntries(
    rescales.map(({ field, factor }) => [field, bar[field] * factor]),
  );
  return { bar: rescales.length === 0 ? bar : { ...bar, ...scaled }, rescales };
}

function spansGlitchRange(bar: DailyBar): boolean {
  const prices = PRICE_FIELDS.map((field) => bar[field]);
  return Math.max(...prices) / Math.min(...prices) > GLITCH_RANGE_MAX_RATIO;
}

function widenRange(bar: DailyBar): DailyBar {
  const high = Math.max(bar.open, bar.high, bar.low, bar.close);
  const low = Math.min(bar.open, bar.high, bar.low, bar.close);
  return high === bar.high && low === bar.low ? bar : { ...bar, high, low };
}

function isRepairable(bar: DailyBar): boolean {
  return PRICE_FIELDS.every((field) => Number.isFinite(bar[field]) && bar[field] > 0);
}

export function repairBarShape(bars: readonly DailyBar[]): {
  bars: DailyBar[];
  report: ShapeRepairReport;
} {
  const repaired: DailyBar[] = [];
  const rescaledFields: FieldRescale[] = [];
  const droppedDates: string[] = [];
  let widenedCount = 0;
  for (const bar of bars) {
    if (!isRepairable(bar)) {
      repaired.push(bar);
      continue;
    }
    const scaled = rescaleFields(bar);
    rescaledFields.push(...scaled.rescales);
    if (spansGlitchRange(scaled.bar)) {
      droppedDates.push(bar.date);
      continue;
    }
    const widened = widenRange(scaled.bar);
    if (widened !== scaled.bar) widenedCount++;
    repaired.push(widened);
  }
  return {
    bars: repaired,
    report: {
      rescaled_fields: rescaledFields,
      dropped_glitch_dates: droppedDates,
      ranges_widened: widenedCount,
    },
  };
}
