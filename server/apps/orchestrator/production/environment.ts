/**
 * Every environment variable the production composition root reads, in one
 * place and read ONCE (`readProductionEnvironment`, from
 * `buildProductionComponents`; `buildProductionOrchestrator`'s daily sweeps
 * take the same values off `ProductionComponents.environment`). What a
 * deployment can set is this interface, not a grep of the root. The helpers
 * below take the raw value explicitly — nothing in the root reads
 * `process.env` for itself.
 *
 * `ProductionConfig`'s programmatic fields (`sentimentEnabled`,
 * `sentimentRetrieval`, `xMaxSearchResults`, #1161) win over the environment,
 * and that precedence is applied HERE, not at the use site: a config value
 * must also mean the variable is never parsed, so a malformed
 * `SAMURAI_X_MAX_RESULTS` cannot refuse a boot that never asked for it.
 */
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_MI_ARCHIVE_RETENTION_DAYS,
} from '../../../providers/market-intelligence/index.js';
import { positiveIntegerFromEnv, requireIntegerAtLeast } from '../../../shared/index.js';
import { DEFAULT_MAX_LLM_CALL_ROWS } from '../../../shared/store/index.js';
import { DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS } from '../alert-delivery-log.js';
import type { ProductionConfig } from './config.js';

export interface ProductionEnvironment {
  /** #1035: `SAMURAI_LLM_CAPTURE` — both spend sinks receive this one read */
  readonly captureLlmText: boolean;
  /** #1045: `llm_call_log` row ceiling, applied at boot and on the daily sweep */
  readonly llmCallLogMaxRows: number;
  /** #1060: the MI archive's retention window, applied at boot and on the daily sweep */
  readonly miArchiveRetentionDays: number;
  /** #1131: `alert_delivery_failures`'s retention window, applied at boot and on the daily sweep */
  readonly alertDeliveryFailureRetentionDays: number;
  /** #464 / ADR-0009: `config.sentimentEnabled`, else `SAMURAI_SENTIMENT=off` is the only off switch; anything else runs the stage */
  readonly sentimentEnabled: boolean;
  /**
   * Whether the sentiment agent RETRIEVES (#969), as opposed to asking a model
   * what it remembers: `config.sentimentRetrieval`, else
   * `SAMURAI_SENTIMENT_RETRIEVAL=on`.
   *
   * A separate switch from `sentimentEnabled`, not a widening of it, and
   * DEFAULT OFF. Three reasons, in the order they bite:
   *
   * 1. It changes what the soak measures. `sentiment` has been excluded from
   *    the evidence average while mute (#676); real items put it back in, and
   *    that is the same gate that produced #625's zero-trade result. A run
   *    with this on is a different experiment from #625/#752, and flipping it
   *    by accident would make two soaks silently incomparable.
   * 2. It changes what the run costs. Search results ride in the prompt —
   *    roughly 5,300 input tokens per call at the default result count — so
   *    this is the soak's main LLM cost lever after the debate itself.
   * 3. The metered figure has not yet been reconciled against the provider's
   *    invoice (the plan's V3). Until it has, turning this on is a deliberate,
   *    dated act by an operator, not a default.
   */
  readonly sentimentRetrieval: boolean;
  /**
   * How many X posts a sentiment call retrieves: `config.xMaxSearchResults`
   * (#1161), else `SAMURAI_X_MAX_RESULTS` (#969).
   *
   * The env path is read through the SHARED `positiveIntegerFromEnv` (#1045)
   * rather than a validator of its own. That helper's header makes the
   * argument — "two env vars in one system come to disagree about whether
   * `\"abc\"` means abc, the default, or 0" — and a spend dial is the last
   * place to disagree about it. Concretely it means a malformed value
   * **throws at startup naming the variable** instead of silently falling
   * back, which is the right failure for a setting whose whole job is
   * bounding cost: an operator who typed `SAMURAI_X_MAX_RESULTS=ten` meant to
   * change the spend and should not discover days later that nothing changed.
   *
   * The config path is held to the same bound via `requireIntegerAtLeast`
   * rather than passed through unchecked: without it, a programmatic caller's
   * `0` or `-1` would skip the throw entirely and reach `XSearchClient`'s
   * ceiling clamp, which is built to forgive an operator's excessive value,
   * not to catch a nonsensical one.
   *
   * The ceiling is enforced separately and does NOT throw, on either path.
   * `XSearchClient` clamps to `[1, MAX_SEARCH_RESULTS_CEILING]` and warns,
   * because 100 is a well-formed integer that an operator plausibly meant as
   * "as many as you can" — refusing to boot over it would be worse than
   * capping it and saying so. So: unusable input refuses, excessive input
   * clamps.
   */
  readonly xMaxSearchResults: number;
}

const X_MAX_SEARCH_RESULTS_PURPOSE =
  "the number of X posts each sentiment call retrieves, the soak's main LLM cost lever after " +
  'the debate itself (#969)';

export function readProductionEnvironment(
  config: Pick<
    ProductionConfig,
    'processEnv' | 'sentimentEnabled' | 'sentimentRetrieval' | 'xMaxSearchResults'
  >,
): ProductionEnvironment {
  const env = config.processEnv ?? process.env;
  return {
    captureLlmText: captureLlmTextFromEnvironment(env.SAMURAI_LLM_CAPTURE),
    llmCallLogMaxRows: llmCallLogMaxRowsFromEnvironment(env[ENV_LLM_CALL_LOG_MAX_ROWS]),
    miArchiveRetentionDays: miArchiveRetentionDaysFromEnvironment(
      env[ENV_MI_ARCHIVE_RETENTION_DAYS],
    ),
    alertDeliveryFailureRetentionDays: alertDeliveryFailureRetentionDaysFromEnvironment(
      env[ENV_ALERT_DELIVERY_FAILURE_RETENTION_DAYS],
    ),
    sentimentEnabled:
      config.sentimentEnabled ?? env.SAMURAI_SENTIMENT?.trim().toLowerCase() !== 'off',
    sentimentRetrieval:
      config.sentimentRetrieval ?? env.SAMURAI_SENTIMENT_RETRIEVAL?.trim().toLowerCase() === 'on',
    xMaxSearchResults:
      config.xMaxSearchResults === undefined
        ? positiveIntegerFromEnv(
            env[ENV_X_MAX_SEARCH_RESULTS],
            ENV_X_MAX_SEARCH_RESULTS,
            DEFAULT_MAX_SEARCH_RESULTS,
            1,
            X_MAX_SEARCH_RESULTS_PURPOSE,
          )
        : requireIntegerAtLeast(
            config.xMaxSearchResults,
            'ProductionConfig.xMaxSearchResults',
            1,
            X_MAX_SEARCH_RESULTS_PURPOSE,
          ),
  };
}

/**
 * Whether LLM prompt/response text is persisted to `llm_call_log` (#1035).
 *
 * DEFAULT ON, and the asymmetry with `SAMURAI_ALERTS` — which deliberately has
 * no default at all — is the point rather than an inconsistency. An unset
 * `SAMURAI_ALERTS` would silently route operator alerts to an EXTERNAL
 * channel, so it must be named out loud; this writes to a local SQLite table
 * at a measured ~7 MB per 14-day soak. The cost of defaulting wrong is a few
 * megabytes of disk. The cost of defaulting OFF is that the soak this exists
 * to diagnose runs without it, and nobody finds out until they need the data
 * and it was never recorded.
 *
 * Exported so the default is pinned by a test rather than inferred from a
 * `!== 'off'` buried in a composition root — this repo's characteristic
 * defect is a mechanism that is built, tested, and then reached by nothing on
 * the shipped path.
 */
export function captureLlmTextFromEnvironment(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== 'off';
}

/** The variable that overrides `llm_call_log`'s row ceiling (#1045) */
export const ENV_LLM_CALL_LOG_MAX_ROWS = 'SAMURAI_LLM_CALL_LOG_MAX_ROWS';

/** The variable that overrides the MI archive's retention window (#1060) */
export const ENV_MI_ARCHIVE_RETENTION_DAYS = 'SAMURAI_MI_ARCHIVE_RETENTION_DAYS';

/** The variable that overrides `alert_delivery_failures`'s retention window (#1131) */
export const ENV_ALERT_DELIVERY_FAILURE_RETENTION_DAYS =
  'SAMURAI_ALERT_DELIVERY_FAILURE_RETENTION_DAYS';

/** The variable that overrides how many X posts a sentiment call fetches (#969) */
export const ENV_X_MAX_SEARCH_RESULTS = 'SAMURAI_X_MAX_RESULTS';

/**
 * How many `llm_call_log` rows to keep (#1045).
 *
 * `min = 1`, not `0` — the one place this deliberately departs from the file
 * sink's identical-looking setting, where `0` legally means "keep nothing".
 * Here "keep nothing" is already spelled `SAMURAI_LLM_CAPTURE=off`, and a
 * ceiling of zero would mean writing every prompt to disk purely to delete it
 * on the next sweep. Two spellings for one intention is how a config comes to
 * disagree with itself, so this one refuses.
 *
 * Exported and tested for the same reason `captureLlmTextFromEnvironment` is:
 * a retention policy read inline in a 4,000-line composition root is a policy
 * nobody can see.
 */
export function llmCallLogMaxRowsFromEnvironment(value: string | undefined): number {
  return positiveIntegerFromEnv(
    value,
    ENV_LLM_CALL_LOG_MAX_ROWS,
    DEFAULT_MAX_LLM_CALL_ROWS,
    1,
    "the captured LLM prompt/response table's row ceiling (#1045)",
  );
}

/**
 * How many days of MI archive history to keep (#1060).
 *
 * The specced rule here is a DAY WINDOW, not a row ceiling — the opposite of
 * `llmCallLogMaxRowsFromEnvironment` above, and deliberately so: LLM capture
 * volume is cadence-bound (a 15-minute-debate measurement does not hold at a
 * different cadence), whereas the archive's value genuinely is time-bound — a
 * 90-day-old news item is not useful to a backtest replay of last week. The
 * six spec statements this settles are reconciled in
 * `docs/specs/market-intelligence-spec.md`.
 *
 * `min = 1`, matching `llmCallLogMaxRowsFromEnvironment`'s reasoning: there is
 * no "keep nothing" spelling to protect here (unlike `SAMURAI_LLM_CAPTURE`),
 * but a zero-day window would purge same-tick writes before `hydrate()` could
 * ever read them back, which is not a retention policy anyone would choose on
 * purpose.
 */
export function miArchiveRetentionDaysFromEnvironment(value: string | undefined): number {
  return positiveIntegerFromEnv(
    value,
    ENV_MI_ARCHIVE_RETENTION_DAYS,
    DEFAULT_MI_ARCHIVE_RETENTION_DAYS,
    1,
    "the MI archive's specced retention window (#1060)",
  );
}

/**
 * How many days of `alert_delivery_failures` rows to keep on disk (#1131).
 *
 * Day window, matching `miArchiveRetentionDaysFromEnvironment`'s reasoning:
 * this table's growth tracks outage/event frequency, which is genuinely
 * time-bound, not the cadence-bound growth `llmCallLogMaxRowsFromEnvironment`
 * guards against with a row ceiling instead.
 *
 * `min = 2`, NOT `1` like the two resolvers above. This table also feeds
 * `countFailures`'s Rail window, and 1 day is exactly that window's 24-hour
 * `ALERT_DELIVERY_FAILURE_WINDOW_MS`. Two things break at that equality.
 *
 * FIRST, with no clock premise at all: `contracts/snapshot.ts`'s
 * `alert_delivery_failures_24h` doc drops the tile's old lifetime total,
 * and what makes that defensible is that the same question stays
 * "answerable over the retention window by reading
 * `alert_delivery_failures` directly" — bounded by that retention, never a
 * lifetime. At `retention == window` a row is pruned at about the boundary
 * the tile clears it, so the raw table no longer outlives the tile and
 * answers nothing the tile does not already show.
 *
 * SECOND is the intuitive reason, and it survives only in a form far
 * narrower than it is usually stated: "a 1-day retention lets the daily
 * sweep delete a row the tile is still supposed to count". The prune
 * deletes `timestamp < T_prune - retention`; the count includes
 * `timestamp > asOf - window`. At `retention == window` both predicates
 * hold only for rows in `(asOf - window, T_prune - window)`, an interval
 * that is non-empty exactly when `T_prune > asOf` — so the claim reduces
 * to whether a prune can commit after a live request's `asOf`.
 *
 * Mostly it cannot. The two boundaries are computed in different processes
 * but against one host clock, and `service-api`'s `server.ts` passes a
 * fresh `new Date()` into `buildSnapshot` per request, so a prune that
 * committed before the request began is already behind that request's
 * `asOf`. What that call site gives, though, is sample-then-read rather
 * than read-then-sample: `asOf` is materialised in `server.ts`,
 * `getAlertDeliveryFailureCount` runs partway down `snapshot.ts`'s
 * `buildSnapshot`, after other store reads on the same connection, and
 * nothing spans them — `SqliteDashboardQueryStore` runs each read as its
 * own prepared statement, with no transaction and therefore no snapshot
 * isolation. A
 * prune committing inside THAT gap does have `T_prune > asOf`, and the
 * rows it removes from the counted window are real.
 *
 * So the exposure is the sub-second width of one snapshot build, and it
 * costs a count only if a failure row happens to be timestamped inside a
 * band of exactly `window` ago at the moment the once-a-day sweep lands
 * there. A floor measured in DAYS is not sized against that; FIRST is what
 * it is sized against, and FIRST is the reason for it. That the floor also
 * closes the race is a consequence rather than the argument — above
 * `retention == window` the overlap would need `T_prune > asOf` by the
 * whole `retention - window` difference, a full day at `min = 2`.
 *
 * Given FIRST, 2 is simply the smallest day count strictly above the
 * 24-hour window; nothing is special about 2 beyond the window's size and
 * this variable's unit.
 *
 * The floor by ITSELF orders nothing. `min = 2` is 48h against today's 24h
 * window; widen `ALERT_DELIVERY_FAILURE_WINDOW_MS` to 48h and the two become
 * EQUAL, not ordered. What holds the inequality is a pair of assertions in
 * `alert-delivery-failure-retention.test.ts`, one per direction: a widened
 * window fails its `2 days > ALERT_DELIVERY_FAILURE_WINDOW_MS` check (and
 * the matching one for the 30-day default), a lowered minimum fails its
 * `'1'`-throws case. Both restate the `2` as their own literal rather than
 * reading it from this resolver, so they are guards on the two directions,
 * not a derivation of the bound from this argument.
 */
export function alertDeliveryFailureRetentionDaysFromEnvironment(
  value: string | undefined,
): number {
  return positiveIntegerFromEnv(
    value,
    ENV_ALERT_DELIVERY_FAILURE_RETENTION_DAYS,
    DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS,
    2,
    "alert_delivery_failures's retention window (#1131), which must stay longer than the " +
      '24-hour Rail count window or the table stops outliving the tile that reads it',
  );
}
