/**
 * The **live starting profile** — what `SAMURAI_MODE=live` boots on.
 *
 * `paperStartingProfile` refuses `live` and always will: its notional caps are
 * fractions of an ASSUMED $100,000 paper balance, which is not a statement
 * about how much money the operator is willing to lose. This file is the other
 * half of that refusal — the same profile expressed against a ceiling the
 * operator declared out loud, in `SAMURAI_LIVE_MAX_CAPITAL_USD`.
 *
 * This makes the switch work; it does not tune it. Per the
 * `live-money-graduation` posture, go-live waits on paper metrics, and
 * retuning these dials from real observations is separate follow-up work.
 *
 * `buildStartingProfileConfigs` is shared with the paper profile deliberately
 * (a copy would drift, and the live copy is the one nobody exercises). Only
 * the six notional caps are re-anchored; everything else is inherited
 * verbatim. Values that most deserve a second look before real money:
 *
 * - `breakerConfig.volatility.baseline` is deliberately INERT — no paper run
 *   has ever produced an ATR distribution to calibrate it against, so the
 *   soft volatility entry-halt tier does not fire.
 * - `verdictConfig.drift_tolerance_pct` and `breakerConfig.daily_loss_pct` /
 *   `max_consecutive_losses` are unsourced fractions, not measured ones.
 * - `riskConfig.cii_threshold` is inert regardless (ADR-0002 parks the
 *   WorldMonitor provider), so the geopolitical signal is absent, not quiet.
 * - `tickIntervalMs` (2 min) and `llmBudgetUsd` ($50) are sized for a 14-day
 *   $50 paper soak under ADR-0008, not for a run trying to make money. The
 *   2-minute cadence reached live by inheritance through the shared builder
 *   rather than a live-specific decision, though it is intended (ADR-0014's
 *   tick/decision split needs it so an exit is never up to 15 minutes
 *   stale); spend does not scale with it since the decision path runs once
 *   per debate bar, not once per tick.
 * - `stocksTradingWindow` now gates every live stocks tick, by the same
 *   inheritance — an operator reading this profile for "when does live
 *   trade" must read that field, not the market calendar alone.
 * - `verdictConfig.automation_level: auto` (ADR-0007), in paper AND live —
 *   there is no human gate. The caps and breakers are the whole stop.
 *
 * The capital ceiling is a ceiling, not a target: `SAMURAI_LIVE_MAX_CAPITAL_USD`
 * bounds the run; it does not fund it. Sizing takes `min(ceiling, account
 * equity)` at the one place equity enters a size (`buildTraderStep`,
 * production/direct-bind.ts) — never off equity alone, because a funded
 * account would otherwise silently widen the run past what was declared.
 *
 * The six notional caps are equity-relative, resolved against
 * `portfolio.equity` at evaluate time — the same pattern D5 already used —
 * so the Risk Manager's caps scale with REAL, unclamped account equity, not
 * with the ceiling: `sizingEquity` (direct-bind.ts) clamps equity only at
 * the Trader's sizing inlet, so the drawdown/loss breakers still observe the
 * true account. Consequence, stated rather than hidden: on an account
 * funded ABOVE the declared ceiling, the Risk Manager's caps are no longer
 * bounded by the ceiling at all; the ceiling's only remaining effect is on
 * the Trader's ASK via `sizingEquity`. Declaring a ceiling at or below what
 * the account actually holds is what a capital cap means in the first
 * place, and remains the mitigation.
 */
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

/**
 * The declared capital ceiling. Named once, because it appears in a refusal
 * message, a doc comment and a credential pre-flight, and a typo in any of them
 * would send an operator looking for a variable that does not exist.
 *
 * Declared in the account's currency, deliberately: `LIVE_BOOK_GBP`
 * (paper-profile.ts) is a GBP figure, but this ceiling is whatever number
 * the operator typed, compared by `min(ceiling, equity)` at `sizingEquity`
 * against `portfolio.equity` as the broker returns it — the value is the
 * operator's own and is asked for in the account's currency by name.
 *
 * An operator who means "match the £1,000 book" must type the CONVERTED
 * figure — `LIVE_BOOK_SIZING_USD` is that number at `SIZING_USD_PER_GBP`,
 * and a live run's boot log (`sizing_capital_ceiling_resolved`,
 * production.ts) records this ceiling as declared rather than derived
 * precisely so the two are never confused. Converting here instead would
 * mean silently redenominating a number the operator chose.
 *
 * The two risk-manager guards (`liveBookCeiling` and `equity_ceiling`,
 * risk-manager/index.ts) still refuse to compare their GBP `book` against
 * USD equity — permanently by design; see `same_currency_verified`
 * (risk-manager/types.ts) for why a static rate cannot arm a
 * percentage-point funding test.
 */
export const LIVE_MAX_CAPITAL_ENV_VAR = 'SAMURAI_LIVE_MAX_CAPITAL_USD';

/**
 * The smallest ceiling this function still refuses below — a floor on the
 * DECLARED CEILING itself, not on live equity.
 *
 * `max_position_size_fraction_of_equity` resolves against LIVE EQUITY at
 * evaluate time, not the ceiling, so this floor no longer guarantees
 * `per_trade_size_cap` clears the dust floor — that now depends on whether
 * EQUITY clears `min_viable_notional / max_position_size_fraction_of_equity`
 * (~£200 at today's fractions), which nothing enforces at boot because
 * equity is observed, not declared. A live account funded inside
 * ADR-0017's £100–200 ramp can still boot, spend LLM budget and reject
 * every unclassified entry as dust, ceiling notwithstanding
 * (`d5-trader-cap-agreement.test.ts` asserts this rather than leaving it
 * for a soak to find).
 *
 * Retained anyway for a narrower reason: `sizingEquity` (direct-bind.ts)
 * clamps the Trader's ask to `min(ceiling, equity)`, so a pathologically
 * small ceiling still forces a pathologically small ask regardless of real
 * equity. Refused rather than clamped up to a workable figure: a ceiling is
 * the one number in this system the operator is asserting personally.
 *
 * A function, not a `const`: `orchestrator/index.ts` re-exports this module
 * and is itself imported from `cost-model-backtest/trial-execution.ts`, an
 * import cycle through the barrel. A module-level `const` computed from
 * `RISK_CAP_EQUITY_FRACTIONS` can evaluate while `paper-profile.ts`'s body
 * has not run yet on some entry paths, reading `undefined` — a `NaN` floor
 * that accepts every ceiling. Deferred to call time, the value is always real.
 */
export function minLiveCapitalCeilingUsd(): number {
  return (
    DEFAULT_TRADER_CONFIG.min_viable_notional /
    RISK_CAP_EQUITY_FRACTIONS.max_position_size_fraction_of_equity
  );
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
  return assertLiveCapitalCeilingUsd(Number(trimmed), `${LIVE_MAX_CAPITAL_ENV_VAR}='${trimmed}'`);
}

/**
 * The same bounds as `resolveLiveCapitalCeilingUsd`, applied to a number that
 * did not come from the environment.
 *
 * Split from the parse for one reason: `liveStartingProfile` accepts an
 * injected ceiling, and re-validating it by round-tripping through the env
 * parser produced a message blaming `SAMURAI_LIVE_MAX_CAPITAL_USD` for a
 * value that variable never held. `source` is what the caller is asked to
 * fix, so the message names the real culprit either way — never a
 * credential, and the ceiling itself is not secret, so quoting it back is
 * what makes a typo visible.
 */
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

/**
 * How close a declared ceiling may sit to `LIVE_BOOK_GBP`'s bare number
 * before it looks unconverted. A distinct binding from
 * `D5_BOOK_REFUSE_ABOVE_TOLERANCE` (paper-profile.ts) on purpose: that one
 * bounds how far funded EQUITY may drift from the book before a Risk
 * Manager guard refuses; this bounds how close a DECLARED CEILING may sit to
 * the book's raw number before it looks like a typo. Same value today only
 * because both started from the same "a few percent" idiom — retuning one
 * must not silently retune the other.
 */
const CEILING_LOOKS_LIKE_UNCONVERTED_BOOK_TOLERANCE = 0.05;

/**
 * True when a declared USD ceiling sits close enough to `LIVE_BOOK_GBP`'s
 * bare number to be more likely a typo than a coincidence. See
 * `LIVE_MAX_CAPITAL_ENV_VAR`'s docblock above for why the ceiling is never
 * converted for the operator.
 *
 * USD-account premise, still current: this only makes sense while the live
 * account is USD-denominated (Alpaca). The Saxo venue is opt-in
 * (`SAMURAI_BROKER`, unset means Alpaca) and refuses `live` outright, so
 * every run that reaches this function is still a USD one. Revisit when a
 * GBP-native venue can actually reach live — on that path `LIVE_BOOK_GBP`'s
 * bare number is the correct figure, not a plausible typo.
 */
function ceilingLooksLikeUnconvertedBookGbp(ceilingUsd: number): boolean {
  return (
    Math.abs(ceilingUsd - LIVE_BOOK_GBP) <=
    LIVE_BOOK_GBP * CEILING_LOOKS_LIKE_UNCONVERTED_BOOK_TOLERANCE
  );
}

/** What `liveStartingProfile` returns: the paper profile's shape, plus the ceiling it was built against */
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
  // ceiling from somewhere else must not be able to hand this a NaN. Named as
  // the ARGUMENT, so the message does not blame an environment variable that
  // may be perfectly well set
  const ceiling = assertLiveCapitalCeilingUsd(ceilingUsd, 'liveStartingProfile(ceilingUsd)');

  // A warn, not a refusal: the operator asked for live; they are told what
  // they are getting, once, on the stream a soak actually keeps
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
    // `LIVE_BOOK_GBP` is passed through explicitly here, and ONLY here: this
    // is the one caller for whom the declared book is the account being
    // sized. `paperStartingProfile` calls `buildStartingProfileConfigs` with
    // no book, deliberately, so D5's ceiling never clamps Alpaca's simulated
    // paper balance. See `d5EnvelopeFor`'s docstring (paper-profile.ts).
    ...buildStartingProfileConfigs(undefined, LIVE_BOOK_GBP),
    mode: 'live',
    capitalCeilingUsd: ceiling,
  };
}
