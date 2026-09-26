import type { Venue } from '../../../../contracts/index.js';
import type { DailyBar } from '../../../pipeline/momentum/index.js';
import { ParquetBarStore } from '../../../providers/bar-store/index.js';
import { barsBefore } from './bars.js';

export interface HeldInstrument {
  readonly venue: Venue;
  readonly instrument: string;
}

export type LastBar = DailyBar | undefined | Error;

export interface MarkSource {
  lastBarsBefore(
    held: readonly HeldInstrument[],
    tradingDate: string,
  ): Promise<ReadonlyMap<string, LastBar>>;
}

export function heldKey(held: HeldInstrument): string {
  return `${held.venue}:${held.instrument}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class ParquetMarkSource implements MarkSource {
  constructor(private readonly root: string) {}

  async lastBarsBefore(
    held: readonly HeldInstrument[],
    tradingDate: string,
  ): Promise<ReadonlyMap<string, LastBar>> {
    const found = new Map<string, LastBar>();
    if (held.length === 0) return found;
    let store: ParquetBarStore;
    try {
      store = await ParquetBarStore.open(this.root);
    } catch (error) {
      for (const one of held) found.set(heldKey(one), asError(error));
      return found;
    }
    try {
      for (const one of held) found.set(heldKey(one), await lastBar(store, one, tradingDate));
    } finally {
      store.close();
    }
    return found;
  }
}

async function lastBar(
  store: ParquetBarStore,
  held: HeldInstrument,
  tradingDate: string,
): Promise<LastBar> {
  try {
    const series = await store.readSeries(held.venue, held.instrument);
    return series === undefined ? undefined : barsBefore(series, tradingDate).at(-1);
  } catch (error) {
    return asError(error);
  }
}
