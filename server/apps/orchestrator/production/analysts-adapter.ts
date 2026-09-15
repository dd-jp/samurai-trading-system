/**
 * Production Composition Root: Analysts adapter (ticket #235). See
 * ADR-0004 §3, docs/specs/orchestrator-spec.md ("Module: Production
 * Composition Root"), closed wayfinder map #224.
 *
 * `AnalystOrchestrator.runAnalysts(trace_id, signal, clock)` takes three
 * positional arguments and returns `AnalystRunResult` (`{ views,
 * analyst_count, skipped, failures }`); `TickSteps.analysts` takes one object
 * (`{ trace_id, signal, clock }`) and returns bare `AnalystView[]`. This
 * adapter only narrows the call/return shape — it does not change
 * `AnalystOrchestrator`'s applicability filtering or quorum logic (#235 AC).
 * An empty view array is exactly `runAnalysts`'s `skipped` case, preserving
 * the existing quorum-skip contract `SequentialTickRunner` short-circuits on.
 *
 * **Failures are logged here (issue #358 item 4).** Narrowing to `views` used
 * to drop `failures` on the floor, and that drop is why a total market-data
 * outage — every crypto request 404ing against a wrong API version — looked
 * like a quiet decision for a whole paper run. `SequentialTickRunner` sees only
 * the view array, so its own line carries no reason at all; the only place the
 * reasons still exist is right here, between `runAnalysts` returning and the
 * narrowing throwing them away. So this is where they get emitted, on the same
 * `trace_id` the tick's own lines carry.
 *
 * #1080 carried ONE bit of that back to the runner rather than all of it: the
 * `skipKinds` relay below reports whether the mandatory failure was a deadline
 * or a fault, which is what the audit row and the dashboard need to stop
 * reading a starved sub-budget as a quiet market. The reasons themselves stay
 * here — `audit_log.decision` is a word, not a place for upstream-controlled
 * text.
 *
 * Level splits on `role`, because the two cases are operationally different:
 * a mandatory persona failing HALTED trading for this instrument (`error`); an
 * optional one failing only shrank the debate panel and the tick continued
 * (`warn`). Both are logged even though only the first is a skip — an optional
 * analyst that has been failing silently for a week is worth seeing too.
 *
 * **`failure.reason` is upstream-controlled, so it is bounded and masked**
 * (PR #360 review). It is not a string this repo authors end to end:
 * `classifyAlpacaDataResponse` bakes the provider's response BODY into the
 * message, and `classifyAlpacaDataNetworkError` bakes an arbitrary
 * `error.message` in with no cap at all. No live path can put a credential
 * there today — Alpaca authenticates by header, never by URL, and the one
 * credential this system carries *in* a URL (the Telegram bot token,
 * `/bot<token>/<method>`) is unreachable from an analyst, which depends only on
 * `MarketDataService` and the in-memory `MarketIntelligenceStore`. But a log
 * line should not silently depend on that remaining true through the next
 * refactor, and bounding costs nothing operationally: the operator needs WHICH
 * analyst failed and WHY in short form, and both survive.
 *
 * Deliberately narrow. `sanitizeLogText` (moved to
 * `server/shared/sanitize-log-text.ts` in #364, when the debate adapter became
 * its second caller) masks only well-known credential-carrying SYNTAXES
 * (`bot<digits>:<token>`, `Bearer <token>`,
 * `key/secret/token/password/auth = <value>`), never anything that merely looks
 * random. Over-masking would put us back where this ticket started — a quorum
 * skip whose stated cause says nothing — so a real failure like
 * `computeIndicator: sma(14) needs 14 bars but received 13` must pass through
 * verbatim, and a test pins exactly that.
 */
import type {
  AnalystFailure,
  AnalystOrchestrator,
  AssetClass,
} from '../../../pipeline/analysts/index.js';
import {
  describeThrownSafely,
  escalatesAt,
  type Logger,
  sanitizeLogText,
} from '../../../shared/index.js';
import { type AnalystSkipKindRelay, skipKindOf } from '../analysts-decision.js';
import type { TickSteps } from '../types.js';
import { type CheckMiCoverageDeps, checkMiCoverage } from './mi-coverage.js';

/**
 * A run of consecutive quorum skips on one instrument (#431, analysts-spec.md
 * story 25). Carries the count and the current reasons, because "the analyst
 * stage has skipped N ticks in a row and here is why" is the whole message.
 */
export interface AnalystSkipAlert {
  instrument: string;
  /** How many ticks in a row have skipped, including this one. Always >= 2. */
  consecutive_skips: number;
  /** The mandatory failures behind THIS skip, already sanitized */
  failures: AnalystFailure[];
  reported_at: Date;
}

/**
 * Where a consecutive-skip alert goes. Declared beside its caller, like
 * `OrphanAlertChannel` in orphan-verdict-scan.ts; the alert catalogue's
 * `analystSkipAlerts` entry (alert-catalogue.ts) implements it.
 */
export interface AnalystSkipAlertChannel {
  postAnalystSkipAlert(alert: AnalystSkipAlert): Promise<void>;
}

/**
 * analysts-spec.md story 25: "an active alert only after 2 consecutive skipped
 * ticks, so that isolated blips stay quiet but systemic breakage reaches me."
 */
export const ALERT_AFTER_CONSECUTIVE_SKIPS = 2;

/**
 * How often the alert repeats while the stage stays broken, counted in further
 * consecutive skips after the first alert.
 *
 * The spec asks for an alert at 2 and says nothing about what happens at 200.
 * Firing once and going quiet is the literal reading, and it fails the case
 * this ticket was actually filed for: a 14-day unattended soak where the single
 * alert lands at hour 0.5, is missed, and nothing ever says it again — 14 days
 * of silence that look exactly like a working system. Firing every tick is the
 * other failure (alert fatigue, #342's lesson). Every 8th skip is ~2 hours at
 * ADR-0008's 15-minute cadence: frequent enough to be noticed, rare enough to
 * stay readable.
 */
export const ALERT_REPEAT_EVERY_SKIPS = 8;

export interface AnalystsStepOptions {
  /** Absent = no alerting, log-only. `production.ts` supplies its log-only default. */
  skipAlerts?: AnalystSkipAlertChannel;
  /**
   * #464: the market-intelligence refresh, TRIGGERED here so it stays inside
   * the tick's in-flight guard and inside the session the scheduler defines —
   * the same reason #397's cadence gating belongs in the Scheduler, and why a
   * second timer was rejected.
   *
   * **Triggered, not awaited (#1085).** In production this is a
   * `MiRefreshQueue`, whose `refresh` enqueues and returns at once, so the
   * analysts read whatever the store already holds. Awaiting it here is what
   * put two LLM round trips in front of every instrument's analyst stage and
   * pushed the pass past the tick interval (#1084). The consequence is that
   * the first tick after news arrives sees the previous context; against the
   * 24h window the analysts read (`COVERAGE_WINDOW_MS`) and a minutes-scale
   * tick, that is a staleness this stage cannot measure.
   *
   * A caller that supplies a bare agent instead gets the old blocking
   * behaviour, which is correct for a focused test that wants the refresh's
   * effect visible to the same call.
   *
   * Absent under `SAMURAI_SENTIMENT=off`, or when Nous is unconfigured —
   * which is the honest default: no agent, no calls, and the analysts keep
   * saying NO DATA.
   */
  marketIntelligence?: MarketIntelligenceRefresh;
  /**
   * The per-name/per-subclass `NO_DATA` coverage check (#752). Absent means
   * no coverage counting and no degraded-coverage alert — the honest default
   * for a caller (a focused unit test, a backtest) that has not wired
   * `MarketIntelligenceStore` and a subclass map through. Never gates the
   * tick either way: see `checkMiCoverage`'s doc comment for why an alert and
   * not a refusal.
   */
  coverage?: CheckMiCoverageDeps;
  /**
   * Where this pass's quorum-skip KIND goes (#1080), for the tick runner to
   * read back through `TickSteps.analystSkipKind`. Absent means every skip
   * records the undifferentiated `quorum_skip`, which is what a caller with no
   * runner attached (a focused unit test) should get.
   */
  skipKinds?: AnalystSkipKindRelay;
}

/** The one method the analysts step calls on `GrokAgent` */
export interface MarketIntelligenceRefresh {
  refresh(trace_id: string, instrument: string, assetClass: AssetClass): Promise<boolean>;
}

/**
 * Runs several MI agents behind the single-refresher seam (#969).
 *
 * ## Why this is needed rather than tidy
 *
 * The composition root used to pick ONE agent: the deterministic news path
 * when it could be built, the sentiment agent only as a fallback. That was
 * correct on its own terms — the sentiment agent ingested `[]` by
 * construction, so a run with both would have paid for a second agent that
 * contributed nothing.
 *
 * It stops being correct the moment sentiment actually retrieves, because the
 * two agents do not overlap: `MiIngestAgent` writes the `news` bucket and
 * `GrokAgent` writes `social`, and `MarketContext` has a slot for each.
 * Choosing between them means one bucket is empty by construction whichever
 * way the choice falls — and with the news path available, the empty one is
 * `social`, which is the bucket #969 exists to fill. A retrieving client that
 * the shipped path never calls is this repo's characteristic defect, not a
 * new one.
 *
 * SEQUENTIAL, not `Promise.all`: these agents are independent but their spend
 * accounting is not — both meter into `llm_spend`, and the cap is a pure read
 * that reserves nothing, so concurrent calls all see the same pre-spend total
 * and can each pass a check the pair would fail. Bucketed refreshes make the
 * common case two immediate returns anyway.
 *
 * **This ordering is necessary and was never sufficient (#1085).** It holds
 * only WITHIN one instrument, and #1013 admits several instrument passes
 * concurrently — so up to four of these ran against the same total. In
 * production the composed refresher is wrapped in `MiRefreshQueue`, which
 * serialises across instruments too and puts one cap check in front of each
 * dispatch. That is where the property is actually enforced; this stays
 * sequential so the guarantee does not depend on the wrapper being present.
 *
 * NEVER THROWS, matching what the seam already promises: an MI outage must
 * degrade the debate to NO_DATA_MARKER, not fail a tick that would otherwise
 * have traded. Both implementations already catch internally; this holds the
 * line for any future one that forgets.
 */
export function composeMarketIntelligence(
  agents: readonly (MarketIntelligenceRefresh | undefined)[],
): MarketIntelligenceRefresh | undefined {
  const present = agents.filter((agent): agent is MarketIntelligenceRefresh => agent !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];

  return {
    async refresh(trace_id, instrument, assetClass) {
      let refreshed = false;
      for (const agent of present) {
        // `catch` rather than trusting the contract: one agent's failure must
        // not stop the others from filling their own bucket
        try {
          if (await agent.refresh(trace_id, instrument, assetClass)) refreshed = true;
        } catch {
          // Deliberately swallowed here. Both shipped agents log their own
          // failures with the instrument and the cause; re-logging without
          // that context would add noise, and rethrowing would fail the tick
        }
      }
      return refreshed;
    },
  };
}

export function buildAnalystsStep(
  orchestrator: AnalystOrchestrator,
  logger?: Logger,
  options: AnalystsStepOptions = {},
): TickSteps['analysts'] {
  /**
   * Consecutive skips per instrument, in memory.
   *
   * Restart-clean on purpose. The counter exists to distinguish an isolated
   * blip from systemic breakage, and a process that just restarted has no
   * evidence about the previous process's ticks. Persisting it would make the
   * first tick after a crash-restart inherit a run it did not observe — and the
   * crash itself is already alarmed by the heartbeat's silence.
   */
  const consecutiveSkips = new Map<string, number>();

  return async ({ trace_id, signal, clock, bar }) => {
    // The refresh is triggered here and, in production, completes elsewhere —
    // see `AnalystsStepOptions.marketIntelligence`. Still awaited, because what
    // `MiRefreshQueue.refresh` costs is a map insert: NO LLM CALL runs inline,
    // and not even the queue's own `spendCap.check()` does — `#pump` schedules
    // the drain on a microtask rather than entering it, so nothing of the
    // refresh runs on this stack at all. That is the whole difference from the
    // multi-second round trips this line used to await
    // Keeping the `await` keeps the ordering with the coverage check below
    // deterministic for a caller that does supply a blocking agent
    // No refresher throws: market intelligence is an optional input, and an
    // outage must degrade the debate to NO_DATA_MARKER rather than fail a tick
    // that would otherwise have traded
    await options.marketIntelligence?.refresh(trace_id, signal.asset, signal.asset_class);

    // #752: after the refresh, so the freshest write for this tick is what
    // the coverage check reads. Never gates the tick — see `checkMiCoverage`'s
    // doc comment (mi-coverage.ts) for why this is an alert, not a refusal
    if (options.coverage !== undefined) {
      await checkMiCoverage(options.coverage, {
        trace_id,
        instrument: signal.asset,
        assetClass: signal.asset_class,
        reportedAt: clock.now(),
      });
    }

    const result = await orchestrator.runAnalysts(trace_id, signal, clock, bar);

    if (logger !== undefined && result.failures.length > 0) {
      const mandatoryFailed = result.failures.some((failure) => failure.role === 'mandatory');
      // Sanitized once, used for both the message and the payload — the raw
      // `result.failures` array is never logged wholesale
      const safe = result.failures.map((failure: AnalystFailure) => ({
        analyst_type: failure.analyst_type,
        role: failure.role,
        reason: sanitizeLogText(failure.reason),
        kind: failure.kind,
      }));
      const detail = safe
        .map((failure) => `${failure.analyst_type} (${failure.role}): ${failure.reason}`)
        .join('; ');
      logger.log({
        trace_id,
        stage: 'analysts',
        event: 'analyst_panel_degraded',
        level: mandatoryFailed ? 'error' : 'warn',
        message: mandatoryFailed
          ? `analysts: ${signal.asset} quorum NOT met — mandatory analyst failed, no trade is ` +
            `possible this tick: ${detail}`
          : `analysts: ${signal.asset} optional analyst failed, tick continues on a smaller ` +
            `panel: ${detail}`,
        payload: { instrument: signal.asset, failures: safe },
      });
    }

    // #431. The tick boundary is here, not inside `runAnalysts`, which knows
    // nothing about consecutive ticks — `result.skipped` is this tick's answer
    // and the counter is what turns a series of them into a signal
    // Before the alerting below, and unconditionally on a skip: the runner
    // reads this immediately after the step returns, so a throw from the alert
    // transport must not be able to cost the audit row its reason (#1080)
    const skipKind = skipKindOf(result.skipped, result.failures);
    if (skipKind !== undefined) {
      options.skipKinds?.set(trace_id, skipKind);
    }

    if (result.skipped) {
      const count = (consecutiveSkips.get(signal.asset) ?? 0) + 1;
      consecutiveSkips.set(signal.asset, count);
      if (shouldAlertAt(count)) {
        await postSkipAlert(options.skipAlerts, logger, trace_id, {
          instrument: signal.asset,
          consecutive_skips: count,
          failures: result.failures.map((failure) => ({
            analyst_type: failure.analyst_type,
            role: failure.role,
            reason: sanitizeLogText(failure.reason),
            kind: failure.kind,
          })),
          reported_at: clock.now(),
        });
      }
    } else {
      // A single good tick clears the run: the alert is about CONSECUTIVE
      // skips, so an intermittent failure must not accumulate its way to an
      // alert over a week of otherwise healthy ticks
      consecutiveSkips.delete(signal.asset);
    }

    return result.views;
  };
}

const SKIP_CADENCE = { after: ALERT_AFTER_CONSECUTIVE_SKIPS, every: ALERT_REPEAT_EVERY_SKIPS };

function shouldAlertAt(consecutiveSkips: number): boolean {
  return escalatesAt(consecutiveSkips, SKIP_CADENCE);
}

/**
 * Posts the alert, and never lets the transport take the tick down with it.
 *
 * A Telegram outage must not turn "the analysts skipped" into "the orchestrator
 * threw": the tick has already produced its (empty) answer by this point, and
 * the caller is about to act on it. The failure is logged at `error` so the
 * un-delivered alert is at least on the record.
 */
async function postSkipAlert(
  channel: AnalystSkipAlertChannel | undefined,
  logger: Logger | undefined,
  trace_id: string,
  alert: AnalystSkipAlert,
): Promise<void> {
  if (channel === undefined) return;
  try {
    await channel.postAnalystSkipAlert(alert);
  } catch (error) {
    logger?.log({
      // The tick's own id, not the `'analyst-skip'` category label (#1280) —
      // the same id `analyst_panel_degraded` above logs under, so the two join
      //
      // Deliberately NOT the same call as the `analystSkipAlerts` log line
      // (alert-catalogue.ts), which keeps the constant on purpose: that line
      // reports the CONDITION, a run of consecutive skips spanning many ticks,
      // and so belongs to none of them. This line reports one delivery failing
      // in ONE instrument's analysts step, inside the tick whose id is in
      // scope. The two are asymmetric because they are about different events,
      // not because one was missed
      trace_id,
      stage: 'analysts',
      event: 'analyst_skip_alert_send_failed',
      level: 'error',
      message:
        'analyst consecutive-skip alert could not be delivered — the analyst stage is still ' +
        'skipping and nobody has been told',
      payload: {
        instrument: alert.instrument,
        consecutive_skips: alert.consecutive_skips,
        error: sanitizeLogText(describeThrownSafely(error)),
      },
    });
  }
}
