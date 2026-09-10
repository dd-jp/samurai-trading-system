/**
 * `SpendCap` — a hard ceiling on cumulative LLM spend, checked before a debate
 * is admitted.
 *
 * ## Why a cap and not just a slower cadence
 *
 * The soak's budget is a *number of dollars over a fortnight* ($50/14d, David
 * 2026-08-06), and cadence alone cannot deliver that. The only spend estimate
 * this repo has is the indicative ~$45/day figure in `paper-profile.ts`, and
 * `startTickLoop` is a `setTimeout` CHAIN — a cycle is `pass duration +
 * interval`, so stretching the interval does not scale spend linearly and the
 * proportional arithmetic is an upper bound on the saving, not a promise.
 * Cadence gets the run into the right order of magnitude; this makes the
 * budget an actual guarantee rather than a forecast.
 *
 * It also covers the failure modes cadence cannot: a retry storm, a debate
 * that runs more rounds than expected, a model or price change, or simply the
 * estimate being wrong. An unattended 14-day run is exactly where an
 * unmodelled cost multiplies before anyone looks.
 *
 * ## Fail CLOSED, unlike `LlmSpendSink`
 *
 * `SqliteLlmSpendStore.record` deliberately swallows its own failures: it is
 * bookkeeping attached to a call that already happened, and losing a row must
 * never fail a trade. This class is the mirror image. It is a control, read
 * *before* money is spent, so a read it cannot answer must refuse rather than
 * admit — the alternative is that a locked or drifted database silently
 * removes the only ceiling on an unattended run's bill. A refusal short-
 * circuits the tick at Trader with no trade, which is recoverable; an
 * unbounded bill is not.
 */

import { currentTraceId, describeThrownSafely } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import type { Logger } from '../../../shared/types.js';

/** The three refusal kinds `#refuse` stamps and escalates (see its doc). */
export type SpendCapRefusalKind = 'budget' | 'corrupt_ledger' | 'read_fault';

/** The answer, with the figures behind it so a refusal can explain itself. */
export type SpendCapVerdict =
  | {
      /** Admitted: a new debate may proceed. */
      admitted: true;
      /** Cumulative `llm_spend.cost_usd` in this database, in USD. */
      spent_usd: number;
      /** The ceiling being enforced, in USD. */
      budget_usd: number;
    }
  | {
      /** Refused: no new debate may be admitted. */
      admitted: false;
      /** Cumulative `llm_spend.cost_usd` in this database, in USD. */
      spent_usd: number;
      /** The ceiling being enforced, in USD. */
      budget_usd: number;
      /** Operator-readable, safe to log. */
      reason?: string;
      /**
       * `'budget'` is the ceiling actually spent, which stays spent until an
       * operator raises it or starts the run from a fresh store. `'read_fault'`
       * is `llm_spend` failing to answer the SELECT — often transient, clears
       * on its own once the ledger is reachable again. `'corrupt_ledger'` is a
       * `cost_usd` SUM that came back non-finite — a bad row, does not clear
       * on its own. Required on every refusal: `#refuse` always knows which of
       * its three call sites it is, so there is no case where this cannot be
       * stamped truthfully.
       */
      kind: SpendCapRefusalKind;
    };

export const BUDGET_REMEDY =
  'THIS DOES NOT RESOLVE ITSELF: the budget does not refill with time, so every ' +
  'subsequent check will refuse identically until an operator raises the cap or starts ' +
  'the run from a fresh store — a restart alone does not reset it, because the window ' +
  'is the whole llm_spend table (ADR-0008).';

export const READ_FAULT_REMEDY =
  'THIS IS A SPEND-LEDGER READ FAULT, NOT A SPENT BUDGET: llm_spend could not be ' +
  'queried — see llm_spend_cap_read_failed for what threw. If the cause was transient ' +
  '(a lock, a momentary I/O hiccup) the next check recovers on its own; if it persists, ' +
  'an operator needs to fix the underlying fault. Unlike a budget refusal, do not assume ' +
  'every subsequent check will refuse identically — and do not assume it clears, either.';

export const CORRUPT_LEDGER_REMEDY =
  'THIS IS A CORRUPT SPEND LEDGER, NOT A SPENT BUDGET: llm_spend.cost_usd summed to a ' +
  'non-finite number, which means at least one row is bad. This does not clear on its ' +
  'own — an operator needs to find and repair the row before the cap can enforce ' +
  'correctly again.';

/**
 * Remedy text per refusal kind — one copy every refusal log line reads from
 * (`debate-adapter.ts`, `mi-refresh-queue.ts`) instead of each hand-copying
 * its own permanence claim. Total over `SpendCapRefusalKind`.
 */
export function spendCapRefusalRemedy(kind: SpendCapRefusalKind): string {
  switch (kind) {
    case 'budget':
      return BUDGET_REMEDY;
    case 'read_fault':
      return READ_FAULT_REMEDY;
    case 'corrupt_ledger':
      return CORRUPT_LEDGER_REMEDY;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** The seam the debate step admits against. */
export interface SpendCap {
  check(): SpendCapVerdict;
}

/**
 * Admits everything, and says so. The default where no budget is configured —
 * a programmatic composition root, a test, a backtest replay that issues no
 * live calls. `buildProductionOrchestrator` warns loudly when it installs
 * this, because an unattended run without a ceiling is the thing the class
 * above exists to prevent.
 */
export const UNCAPPED_SPEND: SpendCap = {
  check: () => ({ admitted: true, spent_usd: 0, budget_usd: Number.POSITIVE_INFINITY }),
};

/**
 * The cap over `llm_spend`, the same table `SqliteLlmSpendStore` writes.
 *
 * The window is the whole table, deliberately — but NOT because the two
 * figures coincide. They do not: `data/samurai-development.sqlite` already held
 * 196 calls / $0.38 before this cap existed, so "everything this database has
 * ever spent" is strictly more than "what this run has spent". The reason to
 * take the total anyway is that the alternative is worse. A per-process
 * baseline would hand a fresh $50 to every restart, and a 14-day soak on a
 * MacBook will restart — that turns a fortnight's ceiling into a per-crash
 * allowance. A rolling window fails the same way, silently re-admitting spend
 * after a quiet period.
 *
 * The cost of the choice is that the operator's "$50 for this run" and the
 * cap's arithmetic can disagree at boot, so `startingTotal()` exists to make
 * the opening figure loud rather than leaving it assumed to be zero.
 *
 * THE SUM IS A FLOOR, NOT A TOTAL (#1080). `llm_spend` holds a row only for a
 * call that RETURNED — `AnthropicLlmClient.recordSpend` is unreachable from
 * the timeout and error paths — so every attempt the provider generated and
 * billed but that never came back is missing from this arithmetic, and the
 * ceiling enforced here is therefore looser than $50 by exactly that amount.
 * See `recordSpend`'s doc comment for the measured size of the gap in the
 * 2026-09-03 session and for the retry log that now makes it countable. The
 * direction of the error is the unsafe one, which is why it is stated here
 * and not only at the writer.
 */
export class SqliteSpendCap implements SpendCap {
  /**
   * Fired ONCE per latch, not per refusal — two latches, not one per
   * `SpendCapRefusalKind`. `#faultAnnounced` covers BOTH `'read_fault'` and
   * `'corrupt_ledger'`: they get different remedy text, but for
   * escalation purposes they are the same thing — an `llm_spend` the cap
   * could not trust — and an operator who has already been told the ledger
   * is unreliable does not need a second alert distinguishing which way it
   * was unreliable. On a budget refusal the cap does not refill, so every
   * subsequent tick refuses identically — at a 15-minute cadence that would
   * be ~1,000 identical alerts over the rest of a 14-day run, which is how
   * an operator learns to mute the channel. A fault refusal has no such
   * guarantee — see below — but the same once-per-latch rule still applies
   * to it, for the same alert-fatigue reason.
   *
   * **Why two latches and not one boolean.** The two latch groups are
   * unrelated conditions that happen to share an exit path: the budget latch
   * is permanent, while the fault latch covers a transient kind
   * (`'read_fault'`) and a permanent one (`'corrupt_ledger'`) under one
   * latch. A single `SQLITE_BUSY` — at boot,
   * or for one tick mid-run — would fire the fault alert, set a shared latch,
   * and then recover. Ten days later spend crosses the ceiling, the refusal
   * short-circuits on the already-set latch, and the operator hears nothing:
   * the system stops trading for the rest of the soak while the heartbeat
   * keeps beating and ticks keep completing with no trade. That is precisely
   * the silent stop this escalation was added to prevent, so a transient fault
   * must not be able to consume the budget breach's one alert.
   */
  #budgetAnnounced = false;
  #faultAnnounced = false;

  constructor(
    private readonly db: StoreHandle,
    private readonly budgetUsd: number,
    private readonly logger?: Logger,
    /**
     * Escalation for a breach. Optional only so the many tests and
     * programmatic callers need not supply one — but a breach with nowhere to
     * go is the failure this exists to prevent, so the composition root always
     * passes it.
     *
     * **Why this is not just a log line.** A budget breach stops the system
     * trading, permanently, until an operator acts. On an unattended run with
     * no human approval gate (ADR-0007), a silent stop on day 4 is
     * indistinguishable from a quiet market: the heartbeat keeps beating and
     * the ticks keep completing with no trade. That is the same argument
     * issue #431 makes about a silently-skipping analyst stage.
     */
    private readonly onBreach?: (verdict: Extract<SpendCapVerdict, { admitted: false }>) => void,
  ) {
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new Error(
        `SqliteSpendCap: budget must be a positive, finite number of USD (got ${budgetUsd}). ` +
          'A zero or negative ceiling would refuse every debate and read as a dead pipeline; ' +
          'omit the cap entirely (UNCAPPED_SPEND) if that is what is wanted.',
      );
    }
  }

  /**
   * What this database has already spent, for the startup line.
   *
   * The cap's window is the WHOLE table (see the class doc), which is correct
   * across the restarts a 14-day soak will have — a per-process baseline would
   * hand every restart a fresh budget. The cost of that choice is that spend
   * from earlier runs against the same database counts too, and on this
   * machine that is not hypothetical: `data/samurai-development.sqlite` held
   * 196 calls / $0.38 before this cap existed. So the root announces the
   * starting total rather than leaving the operator to assume zero.
   *
   * **This is not a pure read: it escalates, and that is deliberate.** It is
   * `check()` under a name that says why the root is calling it, so a database
   * that is already over the ceiling raises the breach alert at boot rather
   * than one tick later. Boot is the better moment — the operator is most
   * likely still watching, and the run is about to spend a fortnight taking no
   * trade. Since the latches are per latch group, spending the budget alert
   * here cannot mask anything: the only condition it suppresses is the
   * identical budget breach it just reported.
   */
  startingTotal(): SpendCapVerdict {
    return this.check();
  }

  check(): SpendCapVerdict {
    let spent: number;
    try {
      const row = this.db
        .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_spend')
        .get() as { total: number } | undefined;
      spent = row?.total ?? 0;
    } catch (error) {
      // Fail closed — see the module header. Named as a refusal rather than a
      // thrown error so the tick short-circuits the same way a budget breach
      // does, instead of surfacing as an unrelated-looking transport fault.
      const message = describeThrownSafely(error);
      this.logger?.log({
        // Every `check()` caller runs under an ambient trace id except one:
        // the in-tick stages (`RiskCritic.produce`, the debate step) inherit
        // the tick's, and `MiRefreshQueue`'s drain relabels under its own. The
        // exception is `startingTotal()`, which the composition root calls at
        // boot. So the ambient read names whichever caller raised this, and
        // the constant below is reached from boot alone (#1280).
        trace_id: currentTraceId() ?? 'spend-cap',
        stage: 'debate',
        event: 'llm_spend_cap_read_failed',
        level: 'error',
        message:
          'LLM spend cap could not read llm_spend and is REFUSING new debates (fail-closed). ' +
          `No trade will be taken until this is fixed: ${message}`,
        payload: { budget_usd: this.budgetUsd },
      });
      return this.#refuse('read_fault', {
        spent_usd: Number.NaN,
        budget_usd: this.budgetUsd,
        reason: 'spend cap unreadable (fail-closed)',
      });
    }

    if (!Number.isFinite(spent)) {
      // A non-finite SUM means a corrupt `cost_usd` row. Comparing it would
      // make `spent > budget` false and admit forever, so the guard reads as
      // enforced while enforcing nothing — this repo's dominant defect shape.
      return this.#refuse('corrupt_ledger', {
        spent_usd: spent,
        budget_usd: this.budgetUsd,
        reason: 'llm_spend total is not a finite number (fail-closed)',
      });
    }

    if (spent >= this.budgetUsd) {
      return this.#refuse('budget', {
        spent_usd: spent,
        budget_usd: this.budgetUsd,
        reason: `LLM spend cap reached: $${spent.toFixed(2)} of $${this.budgetUsd.toFixed(2)} spent`,
      });
    }

    return { admitted: true, spent_usd: spent, budget_usd: this.budgetUsd };
  }

  /**
   * Escalates the first refusal of its latch group (see the latch field doc)
   * and returns it stamped with its kind.
   *
   * Covers ALL THREE refusal paths — budget reached, unreadable ledger,
   * corrupt ledger — because an operator needs to hear about a ledger the cap
   * cannot trust at least as much as a spent budget: all three stop the
   * system trading, and only one of them is something they meant to happen.
   * `onBreach` failures are swallowed to a `warn`. An alert transport that
   * throws must not convert "the budget is spent" into an unhandled rejection
   * inside the tick — the refusal itself is the load-bearing part, and it has
   * already been decided by the time this runs.
   */
  #refuse(
    kind: SpendCapRefusalKind,
    details: { spent_usd: number; budget_usd: number; reason?: string },
  ): SpendCapVerdict {
    // Stamped on every returned verdict, including the already-announced
    // short-circuit below — a caller reading `kind` off a later, unescalated
    // refusal must see it too, not only the first one that reached `onBreach`.
    const refused: SpendCapVerdict = { admitted: false, ...details, kind };

    if (kind === 'budget') {
      if (this.#budgetAnnounced) return refused;
      this.#budgetAnnounced = true;
    } else {
      if (this.#faultAnnounced) return refused;
      this.#faultAnnounced = true;
    }

    try {
      this.onBreach?.(refused);
    } catch (error) {
      this.logger?.log({
        // Same ambient-or-boot shape as `check()`'s fail-closed line above.
        trace_id: currentTraceId() ?? 'spend-cap',
        stage: 'debate',
        event: 'llm_spend_cap_alert_send_failed',
        level: 'warn',
        message:
          'LLM spend cap breached, and the breach alert channel threw — the refusal stands, ' +
          `but nothing reached an operator: ${describeThrownSafely(error)}`,
        payload: { budget_usd: refused.budget_usd, spent_usd: refused.spent_usd },
      });
    }

    return refused;
  }
}
