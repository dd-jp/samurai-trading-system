import type { Venue } from '../../../contracts/index.js';
import {
  type EodhdExchange,
  type EodhdSplit,
  type SplitsRead,
  splitsAcross,
} from './data/index.js';
import type { SplitReading, SplitStep } from './split.js';

export type SplitBlockReason =
  | 'eodhd_uncovered'
  | 'eodhd_conflict'
  | 'alpaca_uncovered'
  | 'alpaca_conflict'
  | 'sources_disagree';

export interface SplitSources {
  readonly eodhd: readonly SplitsRead[];
  readonly alpaca: readonly SplitsRead[] | undefined;
}

export interface SplitWindow {
  readonly after: string;
  readonly through: string;
}

export type SplitVerdict =
  | {
      readonly kind: 'agree';
      readonly reading: SplitReading;
      readonly unconfirmed: readonly SplitStep[];
    }
  | { readonly kind: 'block'; readonly reason: SplitBlockReason; readonly detail: string };

const EXCHANGES: Readonly<Record<Venue, EodhdExchange>> = {
  alpaca: 'US',
  saxo: 'LSE',
  saxo_cfd_gbp: 'LSE',
  saxo_cfd_usd: 'US',
};

export function exchangeOf(venue: Venue): EodhdExchange {
  return EXCHANGES[venue];
}

const RATIO_AGREEMENT = 1e-6;
// A bar step snaps to a whole ratio within 0.5% (split.ts SNAP_TOLERANCE); a step twice as far
// from EODHD's ratio is a different event
const BAR_STEP_AGREEMENT = 0.01;

function closeTo(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a / b - 1) <= tolerance;
}

function describeSplits(splits: readonly EodhdSplit[]): string {
  if (splits.length === 0) return 'no split';
  return splits.map((split) => `x${split.ratio} on ${split.date}`).join(', ');
}

export function sameSplits(a: readonly EodhdSplit[], b: readonly EodhdSplit[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (split, index) =>
        split.date === b[index]?.date &&
        closeTo(split.ratio, b[index]?.ratio as number, RATIO_AGREEMENT),
    )
  );
}

type Coverage = ReturnType<typeof splitsAcross>;

function uncoveredDetail(source: string, coverage: Exclude<Coverage, { kind: 'covered' }>): string {
  return coverage.kind === 'uncovered'
    ? `${source} reads do not cover ${coverage.from} onward`
    : `${source} reads disagree on ${coverage.date}`;
}

function sourceBlock(
  source: 'eodhd' | 'alpaca',
  coverage: Exclude<Coverage, { kind: 'covered' }>,
): SplitVerdict {
  return {
    kind: 'block',
    reason: `${source}_${coverage.kind}`,
    detail: uncoveredDetail(source, coverage),
  };
}

function unconfirmedSteps(detected: SplitReading, splits: readonly EodhdSplit[]): SplitStep[] {
  return detected.steps.filter(
    (step) =>
      !splits.some(
        (split) => split.date === step.date && closeTo(step.ratio, split.ratio, BAR_STEP_AGREEMENT),
      ),
  );
}

function agreed(splits: readonly EodhdSplit[], detected: SplitReading): SplitVerdict {
  return {
    kind: 'agree',
    reading: {
      ratio: splits.reduce((product, split) => product * split.ratio, 1),
      steps: splits.map(({ date, ratio }) => ({ date, ratio })),
      rejected: [],
    },
    unconfirmed: unconfirmedSteps(detected, splits),
  };
}

function alpacaVerdict(
  eodhd: readonly EodhdSplit[],
  reads: readonly SplitsRead[],
  window: SplitWindow,
): SplitVerdict | undefined {
  const alpaca = splitsAcross(reads, window.after, window.through);
  if (alpaca.kind !== 'covered') return sourceBlock('alpaca', alpaca);
  if (sameSplits(eodhd, alpaca.splits)) return undefined;
  return {
    kind: 'block',
    reason: 'sources_disagree',
    detail: `EODHD lists ${describeSplits(eodhd)}, Alpaca ${describeSplits(alpaca.splits)}`,
  };
}

// David, 2026-10-09 (#2025): EODHD is the split source, Alpaca cross-checks US lines, and a bar
// step only alerts
export function crossCheckSplits(
  sources: SplitSources,
  window: SplitWindow,
  detected: SplitReading,
): SplitVerdict {
  const eodhd = splitsAcross(sources.eodhd, window.after, window.through);
  if (eodhd.kind !== 'covered') return sourceBlock('eodhd', eodhd);
  const alpaca =
    sources.alpaca === undefined ? undefined : alpacaVerdict(eodhd.splits, sources.alpaca, window);
  return alpaca ?? agreed(eodhd.splits, detected);
}
