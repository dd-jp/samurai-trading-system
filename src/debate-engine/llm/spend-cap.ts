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

import type { SharedStore } from '../../shared/store/index.js';
import type { Logger } from '../../shared/types.js';

/** The answer, with the figures behind it so a refusal can explain itself. */
export interface SpendCapVerdict {
  /** Whether a new debate may be admitted. */
  admitted: boolean;
  /** Cumulative `llm_spend.cost_usd` in this database, in USD. */
  spent_usd: number;
  /** The ceiling being enforced, in USD. */
  budget_usd: number;
  /** Present only on a refusal — operator-readable, safe to log. */
  reason?: string;
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
 * The window is the whole table, deliberately: the soak runs against a fresh
 * database, so "everything this database has ever spent" and "what this run
 * has spent" are the same figure, and a total is the one definition that
 * cannot drift from what the operator was promised. A rolling window would
 * silently re-admit spend after a quiet period, which is not what a fortnight's
 * budget means.
 */
export class SqliteSpendCap implements SpendCap {
  /**
   * Fired ONCE, on the first refusal. Not per refusal: the cap does not
   * refill, so every subsequent tick refuses identically — at a 15-minute
   * cadence that would be ~1,000 identical alerts over the rest of a 14-day
   * run, which is how an operator learns to mute the channel.
   */
  #breachAnnounced = false;

  constructor(
    private readonly db: SharedStore,
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
    private readonly onBreach?: (verdict: SpendCapVerdict) => void,
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
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.log({
        trace_id: 'spend-cap',
        stage: 'debate',
        level: 'error',
        message:
          'LLM spend cap could not read llm_spend and is REFUSING new debates (fail-closed). ' +
          `No trade will be taken until this is fixed: ${message}`,
        payload: { budget_usd: this.budgetUsd },
      });
      return this.#refuse({
        admitted: false,
        spent_usd: Number.NaN,
        budget_usd: this.budgetUsd,
        reason: 'spend cap unreadable (fail-closed)',
      });
    }

    if (!Number.isFinite(spent)) {
      // A non-finite SUM means a corrupt `cost_usd` row. Comparing it would
      // make `spent > budget` false and admit forever, so the guard reads as
      // enforced while enforcing nothing — this repo's dominant defect shape.
      return this.#refuse({
        admitted: false,
        spent_usd: spent,
        budget_usd: this.budgetUsd,
        reason: 'llm_spend total is not a finite number (fail-closed)',
      });
    }

    if (spent >= this.budgetUsd) {
      return this.#refuse({
        admitted: false,
        spent_usd: spent,
        budget_usd: this.budgetUsd,
        reason: `LLM spend cap reached: $${spent.toFixed(2)} of $${this.budgetUsd.toFixed(2)} spent`,
      });
    }

    return { admitted: true, spent_usd: spent, budget_usd: this.budgetUsd };
  }

  /**
   * Escalates the first refusal and returns it unchanged.
   *
   * Covers BOTH refusal paths — budget reached and fail-closed — because an
   * operator needs to hear about an unreadable `llm_spend` at least as much as
   * a spent budget: both stop the system trading, and only one of them is
   * something they meant to happen.
   *
   * `onBreach` failures are swallowed to a `warn`. An alert transport that
   * throws must not convert "the budget is spent" into an unhandled rejection
   * inside the tick — the refusal itself is the load-bearing part, and it has
   * already been decided by the time this runs.
   */
  #refuse(verdict: SpendCapVerdict): SpendCapVerdict {
    if (this.#breachAnnounced) return verdict;
    this.#breachAnnounced = true;

    try {
      this.onBreach?.(verdict);
    } catch (error) {
      this.logger?.log({
        trace_id: 'spend-cap',
        stage: 'debate',
        level: 'warn',
        message:
          'LLM spend cap breached, and the breach alert channel threw — the refusal stands, ' +
          `but nothing reached an operator: ${error instanceof Error ? error.message : String(error)}`,
        payload: { budget_usd: verdict.budget_usd, spent_usd: verdict.spent_usd },
      });
    }

    return verdict;
  }
}
