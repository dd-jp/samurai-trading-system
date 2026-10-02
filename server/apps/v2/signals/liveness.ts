import type { Heartbeat } from '../heartbeat.js';

export const SIGNALS_BEAT_EVERY_MS = 5 * 60_000;
export const SIGNALS_FAIL_AFTER = 5;
export const SIGNALS_PASS_STUCK_MS = 15 * 60_000;

// The first success ping comes a full interval after boot, so a process that dies inside it never pings and the check goes down
export class SignalsLiveness {
  #lastBeatMs: number;
  #failures = 0;

  constructor(
    private readonly heartbeat: Heartbeat,
    private readonly nowMs: () => number,
    private readonly passAgeMs: () => number | undefined,
  ) {
    this.#lastBeatMs = nowMs();
  }

  beat(): void {
    const now = this.nowMs();
    if (this.#failures >= SIGNALS_FAIL_AFTER || now - this.#lastBeatMs < SIGNALS_BEAT_EVERY_MS) {
      return;
    }
    if ((this.passAgeMs() ?? 0) > SIGNALS_PASS_STUCK_MS) return;
    this.#lastBeatMs = now;
    void this.heartbeat('success').catch(() => undefined);
  }

  passFinished(ok: boolean): void {
    if (ok) {
      this.#failures = 0;
      return;
    }
    this.#failures += 1;
    if (this.#failures === SIGNALS_FAIL_AFTER) void this.heartbeat('fail').catch(() => undefined);
  }
}
