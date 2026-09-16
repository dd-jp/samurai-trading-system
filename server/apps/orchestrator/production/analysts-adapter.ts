/**
 * Production Composition Root: Analysts adapter.
 *
 * `AnalystOrchestrator.runAnalysts(trace_id, signal, clock)` takes three
 * positional arguments and returns `AnalystRunResult` (`{ views,
 * analyst_count, skipped, failures }`); `TickSteps.analysts` takes one object
 * and returns bare `AnalystView[]`. This adapter only narrows the
 * call/return shape — it does not change `AnalystOrchestrator`'s
 * applicability filtering or quorum logic. An empty view array is exactly
 * `runAnalysts`'s `skipped` case, preserving the quorum-skip contract
 * `SequentialTickRunner` short-circuits on.
 *
 * Failures are logged here because narrowing to `views` would otherwise drop
 * `failures` on the floor — `SequentialTickRunner` sees only the view array,
 * so this is the only place the reasons still exist before they're thrown
 * away. Level splits on `role`: a mandatory failure halts trading for the
 * instrument (`error`); an optional one only shrinks the panel (`warn`), but
 * both are logged so a silently-failing optional analyst is still visible.
 *
 * `failure.reason` is upstream-controlled — `classifyAlpacaDataResponse`
 * bakes the provider's response body into it, uncapped — so it is bounded
 * and masked by `sanitizeLogText` before logging. No live path can put a
 * credential there today, but a log line should not depend on that staying
 * true through the next refactor. The masking targets only well-known
 * credential syntaxes, so a real failure reason still passes through
 * readable.
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
 * A run of consecutive quorum skips on one instrument. Carries the count and
 * the current reasons, because "the analyst stage has skipped N ticks in a
 * row and here is why" is the whole message.
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
 * How often the alert repeats while the stage stays broken, counted in
 * further consecutive skips after the first alert. Firing once and going
 * quiet risks a missed alert going unrepeated for a whole unattended soak;
 * firing every tick is alert fatigue. Every 8th skip balances the two.
 */
export const ALERT_REPEAT_EVERY_SKIPS = 8;

export interface AnalystsStepOptions {
  /** Absent = no alerting, log-only. `production.ts` supplies its log-only default. */
  skipAlerts?: AnalystSkipAlertChannel;
  /**
   * The market-intelligence refresh, triggered here so it stays inside the
   * tick's in-flight guard and the session the scheduler defines.
   *
   * Triggered, not awaited: in production this is a `MiRefreshQueue`, whose
   * `refresh` enqueues and returns at once. Awaiting it here would put LLM
   * round trips in front of every instrument's analyst stage; the tradeoff
   * is that the first tick after news arrives sees the previous context.
   *
   * A caller that supplies a bare agent instead gets the old blocking
   * behaviour, which a focused test can use to see the refresh's effect
   * inline.
   *
   * Absent under `SAMURAI_SENTIMENT=off`, or when Nous is unconfigured —
   * the honest default: no agent, no calls, and the analysts keep saying NO
   * DATA.
   */
  marketIntelligence?: MarketIntelligenceRefresh;
  /**
   * The per-name/per-subclass `NO_DATA` coverage check. Absent means no
   * coverage counting and no degraded-coverage alert — the honest default
   * for a caller that has not wired `MarketIntelligenceStore` and a subclass
   * map through. Never gates the tick either way: see `checkMiCoverage`'s
   * doc comment for why an alert and not a refusal.
   */
  coverage?: CheckMiCoverageDeps;
  /**
   * Where this pass's quorum-skip kind goes, for the tick runner to read
   * back through `TickSteps.analystSkipKind`. Absent means every skip
   * records the undifferentiated `quorum_skip`.
   */
  skipKinds?: AnalystSkipKindRelay;
}

/** The one method the analysts step calls on `GrokAgent` */
export interface MarketIntelligenceRefresh {
  refresh(trace_id: string, instrument: string, assetClass: AssetClass): Promise<boolean>;
}

/**
 * Runs several MI agents behind the single-refresher seam.
 *
 * Needed because the agents don't overlap: `MiIngestAgent` writes the `news`
 * bucket and `GrokAgent` writes `social`, so choosing only one of them
 * leaves the other bucket empty by construction.
 *
 * Sequential, not `Promise.all`: both agents meter into `llm_spend`, and the
 * spend cap is a pure read that reserves nothing, so concurrent calls could
 * each pass a check the pair together would fail. This ordering only holds
 * within one instrument — production wraps the composed refresher in
 * `MiRefreshQueue`, which serializes across instruments too and is where the
 * property is actually enforced.
 *
 * Never throws: an MI outage must degrade the debate to NO_DATA_MARKER, not
 * fail a tick that would otherwise have traded.
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
   * Consecutive skips per instrument, in memory and restart-clean: a process
   * that just restarted has no evidence about the previous process's ticks,
   * and persisting this would make the first tick after a crash-restart
   * inherit a run it did not observe
   */
  const consecutiveSkips = new Map<string, number>();

  return async ({ trace_id, signal, clock, bar }) => {
    // Triggered here, completes elsewhere in production — see
    // `AnalystsStepOptions.marketIntelligence`. Still awaited: enqueuing
    // costs a map insert, no LLM call runs on this stack, and awaiting keeps
    // the ordering with the coverage check below deterministic. Never
    // throws — an MI outage must degrade to NO_DATA_MARKER, not fail the tick
    await options.marketIntelligence?.refresh(trace_id, signal.asset, signal.asset_class);

    // After the refresh, so the freshest write for this tick is what the
    // coverage check reads. Never gates the tick — see `checkMiCoverage`'s
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

    logAnalystFailures(logger, trace_id, signal.asset, result.failures);

    // The tick boundary is here, not inside `runAnalysts`, which knows
    // nothing about consecutive ticks. Set before the alerting below: the
    // runner reads this immediately after the step returns, so a throw from
    // the alert transport must not cost the audit row its reason
    const skipKind = skipKindOf(result.skipped, result.failures);
    if (skipKind !== undefined) {
      options.skipKinds?.set(trace_id, skipKind);
    }

    await recordSkipOutcome(
      consecutiveSkips,
      options,
      logger,
      trace_id,
      signal.asset,
      result,
      clock,
    );

    return result.views;
  };
}

// Split out of `buildAnalystsStep`'s returned closure purely to keep its
// cognitive complexity down — a pure logging side effect over `result`, with
// no ordering dependency on anything else in the tick
function logAnalystFailures(
  logger: Logger | undefined,
  trace_id: string,
  instrument: string,
  failures: readonly AnalystFailure[],
): void {
  if (logger === undefined || failures.length === 0) return;

  const mandatoryFailed = failures.some((failure) => failure.role === 'mandatory');
  // Sanitized once, used for both the message and the payload — the raw
  // `failures` array is never logged wholesale
  const safe = failures.map((failure) => ({
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
      ? `analysts: ${instrument} quorum NOT met — mandatory analyst failed, no trade is ` +
        `possible this tick: ${detail}`
      : `analysts: ${instrument} optional analyst failed, tick continues on a smaller ` +
        `panel: ${detail}`,
    payload: { instrument, failures: safe },
  });
}

// Split out of `buildAnalystsStep`'s returned closure purely to keep its
// cognitive complexity down. Must run after the skipKind set above — the
// caller preserves that by calling this immediately after
async function recordSkipOutcome(
  consecutiveSkips: Map<string, number>,
  options: AnalystsStepOptions,
  logger: Logger | undefined,
  trace_id: string,
  instrument: string,
  result: { skipped: boolean; failures: readonly AnalystFailure[] },
  clock: { now(): Date },
): Promise<void> {
  if (!result.skipped) {
    // A single good tick clears the run: the alert is about CONSECUTIVE
    // skips, so an intermittent failure must not accumulate its way to an
    // alert over a week of otherwise healthy ticks
    consecutiveSkips.delete(instrument);
    return;
  }

  const count = (consecutiveSkips.get(instrument) ?? 0) + 1;
  consecutiveSkips.set(instrument, count);
  if (!shouldAlertAt(count)) return;

  await postSkipAlert(options.skipAlerts, logger, trace_id, {
    instrument,
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
      // The tick's own id, not a category label — joins the
      // `analyst_panel_degraded` line above. Deliberately not the same call
      // as `analystSkipAlerts` (alert-catalogue.ts): that line reports the
      // multi-tick condition, this one reports one delivery failing
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
