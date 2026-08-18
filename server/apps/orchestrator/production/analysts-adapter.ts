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
 * the view array, so it logs `analysts: quorum_skip` at `info` with an empty
 * payload; the only place the reasons still exist is right here, between
 * `runAnalysts` returning and the narrowing throwing them away. So this is
 * where they get emitted, on the same `trace_id` the tick's own lines carry.
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
import { type Logger, sanitizeLogText } from '../../../shared/index.js';
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
  /** The mandatory failures behind THIS skip, already sanitized. */
  failures: AnalystFailure[];
  reported_at: Date;
}

/**
 * Where a consecutive-skip alert goes. Declared beside its caller, like
 * `OrphanAlertChannel` in orphan-verdict-scan.ts; `LoggingAnalystSkipAlertChannel`
 * (console-channels.ts) and `TradeChannelAnalystSkipAlert`
 * (analyst-skip-alert-channel.ts) implement it.
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
   * #464: the Grok market-intelligence refresh, run BEFORE the analysts so
   * `sentiment` and `fundamental` read a populated store rather than reporting
   * `NO_DATA_MARKER`.
   *
   * Here rather than on its own timer for the same reason #397's cadence
   * gating belongs in the Scheduler: a second timer would run independently of
   * the tick's in-flight guard, and the agent's own 4h bucket already makes
   * calling it every pass cheap — it returns immediately unless the bucket has
   * rolled.
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
}

/** The one method the analysts step calls on `GrokAgent`. */
export interface MarketIntelligenceRefresh {
  refresh(trace_id: string, instrument: string, assetClass: AssetClass): Promise<boolean>;
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
    // BEFORE the analysts, so a refreshed window is visible to the very tick
    // that paid for it. `GrokAgent.refresh` never throws — market intelligence
    // is an optional input, and an xAI outage must degrade the debate to
    // NO_DATA_MARKER rather than fail a tick that would otherwise have traded.
    await options.marketIntelligence?.refresh(trace_id, signal.asset, signal.asset_class);

    // #752: after the refresh, so the freshest write for this tick is what
    // the coverage check reads. Never gates the tick — see `checkMiCoverage`'s
    // doc comment (mi-coverage.ts) for why this is an alert, not a refusal.
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
      // `result.failures` array is never logged wholesale.
      const safe = result.failures.map((failure: AnalystFailure) => ({
        analyst_type: failure.analyst_type,
        role: failure.role,
        reason: sanitizeLogText(failure.reason),
      }));
      const detail = safe
        .map((failure) => `${failure.analyst_type} (${failure.role}): ${failure.reason}`)
        .join('; ');
      logger.log({
        trace_id,
        stage: 'analysts',
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
    // and the counter is what turns a series of them into a signal.
    if (result.skipped) {
      const count = (consecutiveSkips.get(signal.asset) ?? 0) + 1;
      consecutiveSkips.set(signal.asset, count);
      if (shouldAlertAt(count)) {
        await postSkipAlert(options.skipAlerts, logger, {
          instrument: signal.asset,
          consecutive_skips: count,
          failures: result.failures.map((failure) => ({
            analyst_type: failure.analyst_type,
            role: failure.role,
            reason: sanitizeLogText(failure.reason),
          })),
          reported_at: clock.now(),
        });
      }
    } else {
      // A single good tick clears the run: the alert is about CONSECUTIVE
      // skips, so an intermittent failure must not accumulate its way to an
      // alert over a week of otherwise healthy ticks.
      consecutiveSkips.delete(signal.asset);
    }

    return result.views;
  };
}

/** Fires at the threshold, then on a bounded repeat while the stage stays broken. */
function shouldAlertAt(consecutiveSkips: number): boolean {
  if (consecutiveSkips < ALERT_AFTER_CONSECUTIVE_SKIPS) return false;
  return (consecutiveSkips - ALERT_AFTER_CONSECUTIVE_SKIPS) % ALERT_REPEAT_EVERY_SKIPS === 0;
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
  alert: AnalystSkipAlert,
): Promise<void> {
  if (channel === undefined) return;
  try {
    await channel.postAnalystSkipAlert(alert);
  } catch (error) {
    logger?.log({
      trace_id: 'analyst-skip',
      stage: 'analysts',
      level: 'error',
      message:
        'analyst consecutive-skip alert could not be delivered — the analyst stage is still ' +
        'skipping and nobody has been told',
      payload: {
        instrument: alert.instrument,
        consecutive_skips: alert.consecutive_skips,
        error: sanitizeLogText(error instanceof Error ? error.message : String(error)),
      },
    });
  }
}
