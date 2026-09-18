import {
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_MI_ARCHIVE_RETENTION_DAYS,
} from '../../../providers/market-intelligence/index.js';
import { positiveIntegerFromEnv, requireIntegerAtLeast } from '../../../shared/index.js';
import { DEFAULT_MAX_LLM_CALL_ROWS } from '../../../shared/store/index.js';
import { DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS } from '../alert-delivery-log.js';
import type { ProductionConfig } from './config.js';

export interface ProductionEnvironment {
  readonly captureLlmText: boolean;
  readonly llmCallLogMaxRows: number;
  readonly miArchiveRetentionDays: number;
  readonly alertDeliveryFailureRetentionDays: number;
  readonly sentimentEnabled: boolean;
  readonly sentimentRetrieval: boolean;
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

export function captureLlmTextFromEnvironment(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== 'off';
}

export const ENV_LLM_CALL_LOG_MAX_ROWS = 'SAMURAI_LLM_CALL_LOG_MAX_ROWS';

export const ENV_MI_ARCHIVE_RETENTION_DAYS = 'SAMURAI_MI_ARCHIVE_RETENTION_DAYS';

export const ENV_ALERT_DELIVERY_FAILURE_RETENTION_DAYS =
  'SAMURAI_ALERT_DELIVERY_FAILURE_RETENTION_DAYS';

export const ENV_X_MAX_SEARCH_RESULTS = 'SAMURAI_X_MAX_RESULTS';

export function llmCallLogMaxRowsFromEnvironment(value: string | undefined): number {
  return positiveIntegerFromEnv(
    value,
    ENV_LLM_CALL_LOG_MAX_ROWS,
    DEFAULT_MAX_LLM_CALL_ROWS,
    1,
    "the captured LLM prompt/response table's row ceiling (#1045)",
  );
}

export function miArchiveRetentionDaysFromEnvironment(value: string | undefined): number {
  return positiveIntegerFromEnv(
    value,
    ENV_MI_ARCHIVE_RETENTION_DAYS,
    DEFAULT_MI_ARCHIVE_RETENTION_DAYS,
    1,
    "the MI archive's specced retention window (#1060)",
  );
}

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
