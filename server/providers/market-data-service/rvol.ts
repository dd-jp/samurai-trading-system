
import type { TradingCalendar } from './trading-calendar.js';
import type { Bar } from './types.js';

export const RVOL_SESSION_WINDOW = 10;

type RvolDegradedReason =
  | 'no_session_anchor'
  | 'no_current_bucket'
  | 'insufficient_sessions'
  | 'zero_baseline';

export interface RvolReading {
  rvol: number | null;
  sessions_used: number;
  sessions_target: number;
  degraded_reason: RvolDegradedReason | null;
}

const NO_CURRENT_BUCKET: RvolReading = {
  rvol: null,
  sessions_used: 0,
  sessions_target: RVOL_SESSION_WINDOW,
  degraded_reason: 'no_current_bucket',
};

function degraded(reason: RvolDegradedReason, sessionsUsed: number): RvolReading {
  return {
    rvol: null,
    sessions_used: sessionsUsed,
    sessions_target: RVOL_SESSION_WINDOW,
    degraded_reason: reason,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

function partitionBarsBySession(bars: Bar[], calendar: TradingCalendar): Map<number, Bar[]> {
  const sessions = new Map<number, Bar[]>();
  for (const b of bars) {
    const key = calendar.sessionStart(b.close_time).getTime();
    const group = sessions.get(key);
    if (group) {
      group.push(b);
    } else {
      sessions.set(key, [b]);
    }
  }
  return sessions;
}

function collectBaselineVolumes(
  sessions: Map<number, Bar[]>,
  priorSessionKeys: number[],
  currentIndex: number,
): number[] {
  const baselineVolumes: number[] = [];
  for (const key of priorSessionKeys) {
    const sessionBars = sessions.get(key) as Bar[];
    const matchingBar = sessionBars[currentIndex];
    if (matchingBar) {
      baselineVolumes.push(matchingBar.volume);
    }
  }
  return baselineVolumes;
}

export function computeRvol(bars: Bar[], calendar: TradingCalendar, asOf: Date): RvolReading {
  if (calendar.sessionEnd(asOf) === null) {
    return degraded('no_session_anchor', 0);
  }

  const currentBar = bars.at(-1);
  if (!currentBar) {
    return NO_CURRENT_BUCKET;
  }

  const sessions = partitionBarsBySession(bars, calendar);

  const currentSessionKey = calendar.sessionStart(currentBar.close_time).getTime();
  const currentSession = sessions.get(currentSessionKey);
  if (!currentSession || currentSession.length === 0) {
    return NO_CURRENT_BUCKET;
  }
  const currentIndex = currentSession.length - 1;
  const currentVolume = currentBar.volume;

  const priorSessionKeys = [...sessions.keys()]
    .filter((key) => key < currentSessionKey)
    .sort((a, b) => b - a)
    .slice(0, RVOL_SESSION_WINDOW);

  const baselineVolumes = collectBaselineVolumes(sessions, priorSessionKeys, currentIndex);

  if (
    priorSessionKeys.length < RVOL_SESSION_WINDOW ||
    baselineVolumes.length < RVOL_SESSION_WINDOW
  ) {
    return degraded('insufficient_sessions', baselineVolumes.length);
  }

  const baseline = median(baselineVolumes);
  if (baseline === 0) {
    return degraded('zero_baseline', baselineVolumes.length);
  }

  return {
    rvol: currentVolume / baseline,
    sessions_used: baselineVolumes.length,
    sessions_target: RVOL_SESSION_WINDOW,
    degraded_reason: null,
  };
}
