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
 * The boot refusal, and the reason the arming gate above cannot carry it.
 *
 * Arming is gated on a ceiling being declared — a profile with none has
 * nothing to write. The CURRENCY CHECK is not, and must not be: every tick
 * sizes against `readFunding`'s `equity`, so an account answering a foreign
 * currency feeds a foreign number into the same fields the GBP book's caps are
 * frozen against ("Static Caps vs Equity-Relative D5"). A profile that
 * declares no ceiling is the case with the LEAST protection downstream, not
 * the most.
 *
 * So the read runs whenever the Saxo funding source is the one in use, and a
 * mismatch refuses the boot rather than being logged. This is what
 * `assertSaxoVenueBootable` used to achieve by refusing every Saxo boot that
 * had not been handed a deliberate account read; #1509 supplies the read and
 * keeps the refusal, rather than trading one for the other.
 */
export function assertSameCurrencyFunding(verdict: SameCurrencyVerdict): void {
  if (verdict.verified) return;
  throw new Error(
    `Orchestrator cannot start: the broker account's balances read answers ` +
      `${verdict.accountCurrency}, but the book is declared in ${verdict.bookCurrency} ` +
      `(LIVE_BOOK_GBP, ADR-0015's 2026-08-18 amendment). Sizing a ${verdict.bookCurrency} ` +
      `book off a ${verdict.accountCurrency} balance is the currency mismatch #949 refuses. ` +
      `The SIM gateway's trial account answers EUR (doc 44 §6.3), so this is the expected ` +
      `outcome there — run the Saxo venue against an account denominated in ` +
      `${verdict.bookCurrency}, or supply ProductionConfig.accountState.`,
  );
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
