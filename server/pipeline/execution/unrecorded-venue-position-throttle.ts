export const UNRECORDED_VENUE_POSITION_REPAGE_EVERY_MS = 30 * 60_000;

export class UnrecordedVenuePositionThrottle {
  readonly #lastPagedAtMs = new Map<string, number>();

  dueFor(instruments: readonly string[], now: Date): string[] {
    const nowMs = now.getTime();
    const seen = new Set(instruments);
    for (const instrument of this.#lastPagedAtMs.keys()) {
      if (!seen.has(instrument)) this.#lastPagedAtMs.delete(instrument);
    }

    const due: string[] = [];
    for (const instrument of seen) {
      const lastPagedAtMs = this.#lastPagedAtMs.get(instrument);
      if (
        lastPagedAtMs !== undefined &&
        nowMs - lastPagedAtMs < UNRECORDED_VENUE_POSITION_REPAGE_EVERY_MS
      ) {
        continue;
      }
      this.#lastPagedAtMs.set(instrument, nowMs);
      due.push(instrument);
    }
    return due;
  }
}
