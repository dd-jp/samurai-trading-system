import type { TraderSkipReason } from '../../../pipeline/trader/index.js';
import { ALERT_REPEAT_EVERY_DIAGNOSTICS } from './trader-diagnostic-alert.js';

interface ExitSkipEpisodeState {
  lastObserved: TraderSkipReason;
  written: ReadonlyMap<TraderSkipReason, number>;
}

function needsBoundedRepeat(skip_reason: TraderSkipReason): boolean {
  return skip_reason === 'exit_held_quantity_diverged';
}

export class ExitSkipWriteThrottle {
  readonly #episodes = new Map<string, ExitSkipEpisodeState>();

  shouldWrite(instrument: string, skip_reason: TraderSkipReason): boolean {
    const prior = this.#episodes.get(instrument);
    const contiguousRepeat = prior?.lastObserved === skip_reason;
    const ticksSinceWrite = prior?.written.get(skip_reason);
    const budgetElapsed =
      ticksSinceWrite === undefined || ticksSinceWrite + 1 >= ALERT_REPEAT_EVERY_DIAGNOSTICS;

    if (contiguousRepeat && !needsBoundedRepeat(skip_reason)) return false;
    return budgetElapsed;
  }

  record(instrument: string, skip_reason: TraderSkipReason, wrote: boolean): void {
    const prior = this.#episodes.get(instrument);
    const written = new Map(prior?.written ?? []);
    for (const [reason, ticksSinceWrite] of written) written.set(reason, ticksSinceWrite + 1);
    if (wrote) written.set(skip_reason, 0);

    this.#episodes.set(instrument, { lastObserved: skip_reason, written });
  }

  clearEpisode(instrument: string): void {
    this.#episodes.delete(instrument);
  }
}
