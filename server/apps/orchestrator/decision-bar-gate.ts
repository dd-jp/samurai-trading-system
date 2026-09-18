import { DEBATE_BAR_TIMEFRAME_MS, floorToBar } from '../../pipeline/debate-engine/index.js';
import type { DecisionBar } from './types.js';

export const DEFAULT_MAX_DECISION_RETRIES_PER_BAR = 5;

export type RescindResult = 'retried' | 'forfeited' | 'stale';

export interface DecisionGate {
  claim(instrument: string, tickTime: Date): DecisionBar | undefined;
  rescind(instrument: string, bar: DecisionBar): RescindResult;
}

export class DebateBarDecisionGate implements DecisionGate {
  readonly #claimedBarMs = new Map<string, number>();
  readonly #retries = new Map<string, number>();
  readonly #retryBarMs = new Map<string, number>();
  readonly #maxRetriesPerBar: number;

  constructor(maxRetriesPerBar: number = DEFAULT_MAX_DECISION_RETRIES_PER_BAR) {
    if (!Number.isFinite(maxRetriesPerBar) || maxRetriesPerBar < 1) {
      throw new Error(
        `DebateBarDecisionGate: maxRetriesPerBar must be a finite number >= 1, got ${maxRetriesPerBar}`,
      );
    }
    this.#maxRetriesPerBar = Math.floor(maxRetriesPerBar);
  }

  claim(instrument: string, tickTime: Date): DecisionBar | undefined {
    const open_time = floorToBar(tickTime, DEBATE_BAR_TIMEFRAME_MS);
    const barMs = open_time.getTime();
    if (this.#claimedBarMs.get(instrument) === barMs) return undefined;
    this.#claimedBarMs.set(instrument, barMs);
    if (this.#retryBarMs.get(instrument) !== barMs) {
      this.#retries.set(instrument, 0);
      this.#retryBarMs.set(instrument, barMs);
    }
    return {
      id: `${open_time.toISOString()}@${DEBATE_BAR_TIMEFRAME_MS}`,
      open_time,
      timeframe_ms: DEBATE_BAR_TIMEFRAME_MS,
    };
  }

  rescind(instrument: string, bar: DecisionBar): RescindResult {
    if (this.#claimedBarMs.get(instrument) !== bar.open_time.getTime()) return 'stale';

    const retries = (this.#retries.get(instrument) ?? 0) + 1;
    if (retries >= this.#maxRetriesPerBar) {
      return 'forfeited';
    }
    this.#retries.set(instrument, retries);
    this.#claimedBarMs.delete(instrument);
    return 'retried';
  }
}
