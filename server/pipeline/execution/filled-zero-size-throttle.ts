export const ALERT_AFTER_CONSECUTIVE_ZERO_SIZE = 3;

export const FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS = 60 * 60_000;

interface ZeroSizeEpisode {
  consecutive: number;
  warned: boolean;
  lastAnnouncedAtMs: number;
}

export class FilledZeroSizeThrottle {
  readonly #episodes = new Map<string, ZeroSizeEpisode>();

  observe(
    idempotencyKey: string,
    now: Date,
  ): { announce: 'warn' | 'info' | null; consecutive: number } {
    const prior = this.#episodes.get(idempotencyKey);
    const consecutive = (prior?.consecutive ?? 0) + 1;
    const nowMs = now.getTime();

    if (!prior?.warned) {
      if (consecutive < ALERT_AFTER_CONSECUTIVE_ZERO_SIZE) {
        this.#episodes.set(idempotencyKey, {
          consecutive,
          warned: false,
          lastAnnouncedAtMs: prior?.lastAnnouncedAtMs ?? 0,
        });
        return { announce: null, consecutive };
      }
      this.#episodes.set(idempotencyKey, { consecutive, warned: true, lastAnnouncedAtMs: nowMs });
      return { announce: 'warn', consecutive };
    }

    if (nowMs - prior.lastAnnouncedAtMs >= FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS) {
      this.#episodes.set(idempotencyKey, { consecutive, warned: true, lastAnnouncedAtMs: nowMs });
      return { announce: 'info', consecutive };
    }

    this.#episodes.set(idempotencyKey, { ...prior, consecutive });
    return { announce: null, consecutive };
  }

  clear(idempotencyKey: string): { hadWarned: boolean } {
    const hadWarned = this.#episodes.get(idempotencyKey)?.warned ?? false;
    this.#episodes.delete(idempotencyKey);
    return { hadWarned };
  }
}
