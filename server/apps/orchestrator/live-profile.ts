import { DEFAULT_TRADER_CONFIG } from '../../pipeline/trader/index.js';
import type { Logger } from '../../shared/index.js';
import { LIVE_MONEY_GATE_SUMMARY } from './live-money-gates.js';
import {
  buildStartingProfileConfigs,
  LIVE_BOOK_GBP,
  LIVE_BOOK_SIZING_USD,
  RISK_CAP_EQUITY_FRACTIONS,
} from './paper-profile.js';
import { type CapitalCeilingUsd, toCapitalCeilingUsd } from './production/capital-ceiling.js';
import type { ProductionConfig } from './production.js';

export const LIVE_MAX_CAPITAL_ENV_VAR = 'SAMURAI_LIVE_MAX_CAPITAL_USD';

export function minLiveCapitalCeilingUsd(): number {
  return (
    DEFAULT_TRADER_CONFIG.min_viable_notional /
    RISK_CAP_EQUITY_FRACTIONS.max_position_size_fraction_of_equity
  );
}

export function resolveLiveCapitalCeilingUsd(
  raw: string | undefined = process.env[LIVE_MAX_CAPITAL_ENV_VAR],
): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    throw new Error(
      `Orchestrator cannot start: SAMURAI_MODE=live requires ${LIVE_MAX_CAPITAL_ENV_VAR}, and it ` +
        'is not set. It is the ceiling every exposure cap and position size in a live run is ' +
        'derived from — a positive number of US dollars, e.g. ' +
        `${LIVE_MAX_CAPITAL_ENV_VAR}=2000. There is no default: refusing to invent the amount ` +
        'of money an operator is willing to lose.',
    );
  }

  return assertLiveCapitalCeilingUsd(Number(trimmed), `${LIVE_MAX_CAPITAL_ENV_VAR}='${trimmed}'`);
}

function assertLiveCapitalCeilingUsd(value: number, source: string): CapitalCeilingUsd {
  const ceiling = toCapitalCeilingUsd(value, source);

  const floor = minLiveCapitalCeilingUsd();
  if (ceiling < floor) {
    throw new Error(
      `Orchestrator cannot start: ${source} is below ${floor}. Below that, ` +
        `\`sizingEquity\` (direct-bind.ts) clamps the Trader's ask to the ceiling itself, and a ` +
        `ceiling this small produces an ask under the ` +
        `${DEFAULT_TRADER_CONFIG.min_viable_notional} dust floor before the Risk Manager is ` +
        'even consulted — a run that connects, spends LLM budget and never trades. Raise the ' +
        'ceiling or stay on paper.',
    );
  }

  return ceiling;
}

const CEILING_LOOKS_LIKE_UNCONVERTED_BOOK_TOLERANCE = 0.05;

function ceilingLooksLikeUnconvertedBookGbp(ceilingUsd: number): boolean {
  return (
    Math.abs(ceilingUsd - LIVE_BOOK_GBP) <=
    LIVE_BOOK_GBP * CEILING_LOOKS_LIKE_UNCONVERTED_BOOK_TOLERANCE
  );
}

export type LiveStartingProfile = ReturnType<typeof buildStartingProfileConfigs> &
  Required<Pick<ProductionConfig, 'mode' | 'capitalCeilingUsd'>>;

export function liveStartingProfile(
  ceilingUsd: number = resolveLiveCapitalCeilingUsd(),
  logger?: Logger,
): LiveStartingProfile {
  const ceiling = assertLiveCapitalCeilingUsd(ceilingUsd, 'liveStartingProfile(ceilingUsd)');

  logger?.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    event: 'live_profile_built',
    level: 'warn',
    message:
      'building the LIVE STARTING PROFILE — real money, no human gate (ADR-0007). Its dials ' +
      "are the paper soak's untuned starting values. The six notional caps are fractions of " +
      `live equity, identical to the paper profile's; ${LIVE_MAX_CAPITAL_ENV_VAR} bounds ` +
      "only the Trader's ask (sizingEquity: min(ceiling, equity)), not the Risk Manager's caps " +
      `— declare a ceiling at or below what the account actually holds. ${LIVE_MONEY_GATE_SUMMARY}`,
    payload: { capital_ceiling_usd: ceiling },
  });

  if (ceilingLooksLikeUnconvertedBookGbp(ceiling)) {
    logger?.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      event: 'live_capital_ceiling_looks_unconverted',
      level: 'warn',
      message:
        `${LIVE_MAX_CAPITAL_ENV_VAR}=${ceiling} is close to LIVE_BOOK_GBP's bare number ` +
        `(${LIVE_BOOK_GBP}) rather than its USD-converted value (${LIVE_BOOK_SIZING_USD}, at ` +
        `SIZING_USD_PER_GBP). ${LIVE_MAX_CAPITAL_ENV_VAR} is USD and is NOT converted for you — if ` +
        `the intent was to match the £${LIVE_BOOK_GBP} book, set ` +
        `${LIVE_MAX_CAPITAL_ENV_VAR}=${LIVE_BOOK_SIZING_USD}. A plausibility warning, not a refusal: ` +
        'if this ceiling is deliberately close to that figure in USD terms, ignore it. (#1441)',
      payload: {
        capital_ceiling_usd: ceiling,
        live_book_gbp: LIVE_BOOK_GBP,
        live_book_sizing_usd: LIVE_BOOK_SIZING_USD,
      },
    });
  }

  return {
    ...buildStartingProfileConfigs(undefined, LIVE_BOOK_GBP),
    mode: 'live',
    capitalCeilingUsd: ceiling,
  };
}
