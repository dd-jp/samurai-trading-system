/**
 * The **live starting profile** (#511) — what `SAMURAI_MODE=live` boots on.
 *
 * `paperStartingProfile` refuses `live` and always will: its notional caps are
 * fractions of an ASSUMED $100,000 paper balance, which is not a statement
 * about how much money the operator is willing to lose. This file is the other
 * half of that refusal — the same profile expressed against a ceiling the
 * operator declared out loud, in `SAMURAI_LIVE_MAX_CAPITAL_USD`.
 *
 * ## This ticket makes the switch WORK. It does not throw it.
 *
 * Per the `live-money-graduation` posture, go-live waits on paper metrics. The
 * dials below are the paper soak's dials; retuning them from real observations
 * is #238's follow-up and explicitly out of this ticket's scope. What is in
 * scope is that the switch is provably wired before anyone reaches for it,
 * rather than discovered to be broken on the day it matters.
 *
 * ## What a live run inherits UNTUNED, enumerated
 *
 * `buildStartingProfileConfigs` is shared with the paper profile deliberately
 * (a copy would drift, and the live copy is the one nobody exercises). Only the
 * six notional caps are re-anchored. Everything else is inherited verbatim, and
 * these are the values that most deserve a second look before real money:
 *
 * - **`breakerConfig.volatility.baseline`** — set to `1_000_000` price units to
 *   be deliberately INERT, because no paper run has ever produced an ATR
 *   distribution to calibrate it against. The soft volatility entry-halt tier
 *   therefore does not fire. Harmless on paper; on live money it means one of
 *   the breaker tiers is decoration.
 * - **`verdictConfig.drift_tolerance_pct`** — "a fraction nobody has yet
 *   observed against a real fill", in the paper profile's own words.
 * - **`breakerConfig.daily_loss_pct` / `max_consecutive_losses`** — `UNSOURCED`.
 * - **`riskConfig.cii_threshold`** — inert regardless (ADR-0002 parks the
 *   WorldMonitor provider), so the geopolitical signal is absent, not quiet.
 * - **`tickIntervalMs` (15 min) and `llmBudgetUsd` ($50)** — sized for a
 *   14-day $50 paper soak under ADR-0008, not for a run trying to make money.
 *   They are not unsafe, but they are not a live budget either.
 * - **`verdictConfig.automation_level: auto`** — ADR-0007, in paper AND live.
 *   There is no human gate. The caps and breakers are the whole stop.
 *
 * ## The capital ceiling is a ceiling, not a target
 *
 * `SAMURAI_LIVE_MAX_CAPITAL_USD` bounds the run; it does not fund it. Sizing
 * takes `min(ceiling, account equity)` at the one place equity enters a size
 * (`buildTraderStep`, production/direct-bind.ts) — so a $200,000 account with a
 * $2,000 ceiling sizes off $2,000, and a $500 account with a $2,000 ceiling
 * sizes off $500. Never off equity alone: that is the whole point, because a
 * funded account would otherwise silently widen the run past what was declared.
 *
 * **Known limit, stated rather than hidden:** the six notional caps are STATIC,
 * derived from the ceiling at boot. When equity is BELOW the ceiling they are
 * therefore looser than an equity-relative cap would be — `portfolio_gross_cap`
 * at 50% of a ceiling above actual equity permits gross exposure above 50% of
 * equity. The paper profile has the identical shape ("If your paper account is
 * not funded at $100k, change this"). The mitigation is to declare a ceiling at
 * or below what the account actually holds, which is what a capital cap means
 * in the first place. Making the caps equity-relative at evaluate time is a
 * separate change to the Risk Manager, not a config edit.
 */
import type { Logger } from '../shared/index.js';
import { DEFAULT_TRADER_CONFIG } from '../trader/index.js';
import { LIVE_MONEY_GATE_SUMMARY } from './live-money-gates.js';
import { buildStartingProfileConfigs, RISK_CAP_EQUITY_FRACTIONS } from './paper-profile.js';
import type { ProductionConfig } from './production.js';

/**
 * The declared capital ceiling. Named once, because it appears in a refusal
 * message, a doc comment and a credential pre-flight, and a typo in any of them
 * would send an operator looking for a variable that does not exist.
 */
export const LIVE_MAX_CAPITAL_ENV_VAR = 'SAMURAI_LIVE_MAX_CAPITAL_USD';

/**
 * Alpaca issues DIFFERENT key pairs for paper and live. Reading the paper pair
 * against `api.alpaca.markets` authenticates nothing — so live mode has its own
 * variables, and never falls back to the paper pair (see
 * `buildDefaultAlpacaBrokerClient`).
 */
export const ALPACA_LIVE_API_KEY_ENV_VAR = 'ALPACA_LIVE_API_KEY';
export const ALPACA_LIVE_API_SECRET_ENV_VAR = 'ALPACA_LIVE_API_SECRET';

/**
 * The smallest ceiling that produces a run capable of trading at all.
 *
 * `max_position_size` is 5% of the ceiling and `min_viable_size` is the
 * Trader's `min_viable_notional` — so below `min_viable_notional / 0.05` every
 * intent is trimmed to fit the per-trade cap and then hard-rejected as dust.
 * That run boots, connects, spends LLM budget and never places an order, and
 * "a run that boots and then trades nothing is indistinguishable at a glance
 * from a clean run that decided not to trade" (paper-profile.ts).
 *
 * Refused rather than clamped up to a workable figure: a ceiling is the one
 * number in this system the operator is asserting personally, and quietly
 * raising it is the last thing that may happen to it.
 *
 * **A function, not a `const`, and the reason is load-bearing rather than
 * stylistic.** `orchestrator/index.ts` re-exports this module and is itself
 * imported from `cost-model-backtest/trial-execution.ts`, so there is an import
 * cycle through the barrel. A module-level `const` computed from
 * `RISK_CAP_EQUITY_FRACTIONS` evaluates while `paper-profile.ts`'s body has not
 * run yet on some entry paths, and reads `undefined` — which is not a type
 * error and would surface as a `NaN` floor that accepts every ceiling. Deferred
 * to call time, the value is always the real one.
 */
export function minLiveCapitalCeilingUsd(): number {
  return DEFAULT_TRADER_CONFIG.min_viable_notional / RISK_CAP_EQUITY_FRACTIONS.max_position_size;
}

/**
 * The declared ceiling, or a refusal to boot.
 *
 * Fails closed on every malformed input — unset, blank, non-numeric, zero,
 * negative, `Infinity`, `NaN`, or too small to trade — because there is no
 * defensible default for "how much of my money may this lose". A default here
 * would be a number nobody chose governing the one dial that exists to be
 * chosen.
 *
 * **Never echoes a credential and never echoes the raw value's surroundings**;
 * the ceiling is not secret, so it is quoted back to make a typo visible, but
 * nothing else from the environment is.
 */
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

  // `Number` rather than `parseFloat`: `parseFloat('2000abc')` is 2000, which
  // would turn a typo into a silently accepted ceiling. `Number` rejects it.
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Orchestrator cannot start: ${LIVE_MAX_CAPITAL_ENV_VAR} must be a positive, finite number ` +
        `of US dollars, but it is '${trimmed}'. Refusing to fall back to a default ceiling — ` +
        'this is the one figure a live run may not guess at.',
    );
  }
  const floor = minLiveCapitalCeilingUsd();
  if (value < floor) {
    throw new Error(
      `Orchestrator cannot start: ${LIVE_MAX_CAPITAL_ENV_VAR}='${trimmed}' is below ` +
        `${floor}, the smallest ceiling that can place a trade. At that ` +
        `ceiling the per-trade cap (${RISK_CAP_EQUITY_FRACTIONS.max_position_size * 100}% of it) ` +
        `falls under the ${DEFAULT_TRADER_CONFIG.min_viable_notional} dust floor, so every ` +
        'intent would be trimmed to fit the cap and then rejected as too small — a run that ' +
        'connects, spends LLM budget and never trades. Raise the ceiling or stay on paper.',
    );
  }

  return value;
}

/** What `liveStartingProfile` returns: the paper profile's shape, plus the ceiling it was built against. */
export type LiveStartingProfile = ReturnType<typeof buildStartingProfileConfigs> &
  Required<Pick<ProductionConfig, 'mode' | 'capitalCeilingUsd'>>;

/**
 * The profile a live run boots on.
 *
 * `mode` is hard-coded `'live'` rather than taken as an argument: this function
 * exists for exactly one mode, and a mode parameter would make it possible to
 * reach the live CAPS from a paper run by passing the wrong string. Paper and
 * backtest go through `paperStartingProfile`.
 *
 * The ceiling is resolved from the environment by default so the composition
 * root has one call to make, and injectable so tests never touch `process.env`.
 */
export function liveStartingProfile(
  ceilingUsd: number = resolveLiveCapitalCeilingUsd(),
  logger?: Logger,
): LiveStartingProfile {
  // Re-validated even when passed explicitly: a programmatic caller computing a
  // ceiling from somewhere else must not be able to hand this a NaN.
  const ceiling = resolveLiveCapitalCeilingUsd(String(ceilingUsd));

  // A warn, not a refusal — #511's scope is to make the switch work. The
  // operator asked for live; they are told what they are getting, once, on the
  // stream a soak actually keeps.
  logger?.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    level: 'warn',
    message:
      'building the LIVE STARTING PROFILE — real money, no human gate (ADR-0007). Its dials ' +
      "are the paper soak's untuned starting values; only the notional caps are re-anchored " +
      `to ${LIVE_MAX_CAPITAL_ENV_VAR}. ${LIVE_MONEY_GATE_SUMMARY}`,
    payload: { capital_ceiling_usd: ceiling },
  });

  return {
    ...buildStartingProfileConfigs(ceiling),
    mode: 'live',
    capitalCeilingUsd: ceiling,
  };
}
