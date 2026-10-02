import type { SaxoAccountBalanceReader } from '../../../pipeline/execution/index.js';
import type { RiskConfig } from '../../../pipeline/risk-manager/index.js';
import type { AccountFunding, AccountFundingSource } from './account-state.js';

const LIVE_BOOK_CURRENCY = 'GBP';

export function saxoFunding(client: SaxoAccountBalanceReader): AccountFundingSource {
  return {
    readFunding: async () => {
      const balance = await client.getBalances();
      return {
        cash: balance.CashBalance,
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
