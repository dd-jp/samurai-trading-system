/**
 * The GBP-native funding read, and the one thing that may arm #949's
 * currency-mismatch guard (#1509).
 *
 * ## What was missing
 *
 * `liveBookCeiling` and `perSubclassDeploymentCap` (risk-manager/index.ts)
 * refuse EVERY live entry with a `currency_mismatch` binding constraint while
 * `same_currency_verified` is absent, because the declared book is GBP
 * (`LIVE_BOOK_GBP`) and the only funding read this repo had was Alpaca's USD
 * `GET /v2/account`. The refusal is correct. What was missing was the thing
 * that lifts it: a read of the account the orders actually go to, reported in
 * the currency that account is denominated in.
 *
 * ## Why the currency is compared and never assumed
 *
 * `GET /port/v1/balances/me` is served by the venue and carries `Currency` —
 * VERIFIED on SIM 2026-09-08, doc 44 §6.3. On that gateway it answered
 * `"EUR"`, on an `IsTrialAccount: true` account. Doc 44 §1's rule is that
 * account-shaped SIM facts (tariffs, entitlements, currency) do NOT carry to
 * the live UK GIA, so that observation establishes only that the field exists.
 * Whether the live GIA reports GBP is unproven here and is settled at runtime
 * by `verifySameCurrency`, not by the venue's identity. "Saxo UK, therefore
 * GBP" is exactly the unchecked inference #949 exists to refuse.
 *
 * ## Why both ceilings are armed together
 *
 * `armSameCurrencyCeilings` writes one verdict to both `live_book_ceiling` and
 * `per_subclass_deployment_cap.equity_ceiling` and offers no way to write one
 * without the other: an unverified ceiling that caps one path and leaves the
 * other uncapped reopens #972 fix 3 in that one state.
 */
import type { SaxoAccountBalanceReader } from '../../../pipeline/execution/adapters/saxo-client.js';
import type { RiskConfig } from '../../../pipeline/risk-manager/index.js';
import type { AccountFunding, AccountFundingSource } from './account-state.js';

/** The currency `LIVE_BOOK_GBP` is denominated in (ADR-0015's 2026-08-18 amendment). */
export const LIVE_BOOK_CURRENCY = 'GBP';

export function saxoFunding(client: SaxoAccountBalanceReader): AccountFundingSource {
  return {
    readFunding: async () => {
      const balance = await client.getBalances();
      return {
        cash: balance.CashBalance,
        // `TotalValue` is the account value including open positions, which is
        // the figure peak-equity, the drawdown envelope and the book ceilings
        // are all defined against. `CashBalance` alone would read as a
        // drawdown the moment cash is deployed into a position.
        equity: balance.TotalValue,
        currency: balance.Currency,
      };
    },
  };
}

/**
 * Whether this config carries a ceiling the verdict could arm.
 *
 * The boot-time funding read is gated on this so a run with no ceiling makes
 * no call whose answer changes nothing. `paperStartingProfile` sets neither
 * ceiling; `liveStartingProfile` sets both (`buildStartingProfileConfigs`
 * with `LIVE_BOOK_GBP`).
 */
export function hasSameCurrencyCeiling(config: RiskConfig): boolean {
  return (
    config.live_book_ceiling !== undefined ||
    config.per_subclass_deployment_cap?.equity_ceiling !== undefined
  );
}

export interface SameCurrencyVerdict {
  readonly verified: boolean;
  readonly bookCurrency: string;
  readonly accountCurrency: string;
}

/**
 * Case-insensitive because ISO 4217 codes are case-insensitive identifiers and
 * a casing difference is not a funding fact; nothing else is normalised, so a
 * venue answering anything but the book's currency stays refused.
 */
export function verifySameCurrency(
  funding: AccountFunding,
  bookCurrency: string = LIVE_BOOK_CURRENCY,
): SameCurrencyVerdict {
  return {
    verified: funding.currency.toUpperCase() === bookCurrency.toUpperCase(),
    bookCurrency,
    accountCurrency: funding.currency,
  };
}

/**
 * Returns `config` unchanged when the verdict is unverified — absent is what
 * the guard already refuses on, and writing `false` explicitly would claim a
 * check ran on configs that carry no ceiling at all.
 */
export function armSameCurrencyCeilings(
  config: RiskConfig,
  verdict: SameCurrencyVerdict,
): RiskConfig {
  if (!verdict.verified) return config;
  const cap = config.per_subclass_deployment_cap;
  return {
    ...config,
    ...(config.live_book_ceiling === undefined
      ? {}
      : { live_book_ceiling: { ...config.live_book_ceiling, same_currency_verified: true } }),
    ...(cap?.equity_ceiling === undefined
      ? {}
      : {
          per_subclass_deployment_cap: {
            ...cap,
            equity_ceiling: { ...cap.equity_ceiling, same_currency_verified: true },
          },
        }),
  };
}
