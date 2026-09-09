/**
 * Throttle for `FILLED_WITH_ZERO_SIZE` (#1087, ingest-fills.ts) — a lot
 * `reconcile()` adopted as `filled`/`partially_filled` whose `filled_size`
 * is still zero.
 *
 * #1383 (review round 1, coordinator ruling): a pure "warn once, then total
 * silence" design closes the flood (a lot wedged for a 20h soak produced
 * ~600 identical WARN lines under the pre-#1383 every-8-poll repeat —
 * measured: `fill_priced_at_zero_size` 618/2102 structured lines, 29.4%) but
 * makes a genuinely wedged lot invisible between its first warning and a
 * restart, which is exactly the case #1128's `ExitSkipWriteThrottle` (see
 * `exit-skip-write-throttle.ts`) relies on this channel to keep surfaced.
 * The fix here has two parts on the same per-lot state machine:
 *
 *  - `warn`, exactly once, on the poll `consecutive` first reaches
 *    `ALERT_AFTER_CONSECUTIVE_ZERO_SIZE` — the transition an operator must
 *    act on, not the state.
 *  - `info`, re-announced at most once every `FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS`
 *    of wall-clock time while the lot stays wedged — low-cadence, so a
 *    still-open incident does not vanish from the log between the first
 *    warning and a restart, but a genuine wedge (hours to days, #1087's META
 *    case ran 14.6h before detection) produces a handful of lines, not
 *    thousands. Time-based rather than poll-count-based deliberately: this
 *    throttle's callers run at whatever poll cadence their process chooses
 *    (15s in the incident that motivated #1087, unspecified in general), and
 *    a poll-count repeat (the shape every OTHER throttle in this repo uses —
 *    `ALERT_REPEAT_EVERY_DIAGNOSTICS`/`_NO_DATA`/`_DEGRADED_TICKS`/`_SKIPS`,
 *    all tuned as WARN cadences) would make re-announcement frequency a
 *    silent function of that cadence instead of a stated interval.
 *
 * One instance per composition root (`production.ts`, `control-arm-wiring.ts`,
 * each `smoke-run.ts` scenario, `place-soak-position.ts`), threaded through
 * every `Execution` surface built from that root's deps — not a
 * module-level singleton, so a second surface built from the same deps
 * continues the first surface's episode instead of starting its own
 * (`filled-zero-size-wiring.test.ts`). In-memory and restart-clean, same
 * posture as `MiCoverageMonitor`/`TraderDiagnosticThrottle`: a process that
 * just restarted has no evidence about the previous process's polls.
 *
 * `clear()` runs from exactly one call site (`ingest-fills.ts`'s
 * `advanceLot`, the `filledSize > 0` branch) — the same single site the
 * pre-#1383 design used. `reconcile.ts`'s own `rejected`/`adopted` branches
 * cannot resolve an already-wedged lot: `reconcileLot` only runs for
 * `IN_FLIGHT` (`pending`/`submitted`) positions, and a lot has to be
 * `filled`/`partially_filled` to reach this throttle at all. The only way a
 * wedged lot leaves that state without going through `advanceLot` is an
 * out-of-band store write — e.g. #1186, the named repair for the incident's
 * wedged META lot, done directly against `open_positions`. That path never
 * calls `clear()` either, and its episode leaks for the rest of the
 * process's life. Accepted, not a regression introduced here: bounded by
 * total positions ever opened, and inert once leaked — the
 * `idempotency_key` that leaked belongs to a lot that has left
 * `getOpenPositions()` for good, so `observe()` is never called for it
 * again and it can neither re-warn nor falsely report
 * `fill_zero_size_cleared`. Exercised directly in `ingest-fills.test.ts`
 * ("a lot resolved by rejection, not by advancing, never reports cleared").
 */
export const ALERT_AFTER_CONSECUTIVE_ZERO_SIZE = 3;

/**
 * How often the `info` re-announcement may repeat while a lot stays warned
 * and wedged, in wall-clock milliseconds. One hour: frequent enough that an
 * operator scanning a day's log sees the incident is still open and how old
 * it has grown, rare enough that even a multi-day wedge stays a handful of
 * lines. Not tuned against any specific poll cadence — see the class doc.
 */
export const FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS = 60 * 60_000;

interface ZeroSizeEpisode {
  consecutive: number;
  warned: boolean;
  /** Epoch ms of the last `warn`/`info` line this episode produced; unused until `warned`. */
  lastAnnouncedAtMs: number;
}

export class FilledZeroSizeThrottle {
  readonly #episodes = new Map<string, ZeroSizeEpisode>();

  /**
   * Whether THIS observation should announce, and at what level: `'warn'`
   * once, on the poll where `consecutive` first reaches
   * `ALERT_AFTER_CONSECUTIVE_ZERO_SIZE`; `'info'` on the first later poll at
   * least `FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS` after the previous
   * announcement; `null` otherwise. `now` is the caller's own clock reading
   * (`ingest-fills.ts` already reads one per poll) — never read internally,
   * so this stays correct under the backtest clock too.
   */
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

  /**
   * Ends a lot's episode (it advanced past zero). Returns whether that
   * episode ever warned, so the caller can log the matching `info` "cleared"
   * transition — but only for an episode that actually paged, never for one
   * that self-resolved inside the grace window (mirrors
   * `SequentialTickRunner.reportAdvisoryWarnings`'s `hadWarnings` gate,
   * tick-runner.ts, #303).
   */
  clear(idempotencyKey: string): { hadWarned: boolean } {
    const hadWarned = this.#episodes.get(idempotencyKey)?.warned ?? false;
    this.#episodes.delete(idempotencyKey);
    return { hadWarned };
  }
}
