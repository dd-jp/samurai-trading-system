import { describe, expect, it } from 'vitest';

import type { SaxoAccountBalance } from '../../../pipeline/execution/adapters/saxo-client.js';
import type { RiskConfig } from '../../../pipeline/risk-manager/index.js';
import { LIVE_BOOK_GBP } from '../paper-profile.js';
import {
  armSameCurrencyCeilings,
  assertSameCurrencyFunding,
  saxoFunding,
  verifySameCurrency,
} from './saxo-funding.js';

/**
 * A correctly funded live book: £1,000, ADR-0015's 2026-08-18 amendment, in
 * the currency it is declared in. `TotalValue` equals `CashBalance` because a
 * flat book holds no positions.
 */
const GBP_FUNDED: SaxoAccountBalance = {
  Currency: 'GBP',
  CashBalance: LIVE_BOOK_GBP,
  TotalValue: LIVE_BOOK_GBP,
};

/** Measured on the SIM trial account, doc 44 §6.3 — the negative case is real. */
const SIM_TRIAL: SaxoAccountBalance = {
  Currency: 'EUR',
  CashBalance: 100_000,
  TotalValue: 100_000,
};

function clientReturning(balance: SaxoAccountBalance) {
  return { getBalances: async () => balance };
}

/** The ceilings `liveStartingProfile` ships, before anything arms them. */
function liveShapedConfig(): RiskConfig {
  return {
    live_book_ceiling: { book: LIVE_BOOK_GBP, refuse_above_tolerance: 0.05 },
    per_subclass_deployment_cap: {
      equity_ceiling: { book: LIVE_BOOK_GBP, refuse_above_tolerance: 0.05 },
    },
  } as unknown as RiskConfig;
}

describe('saxoFunding (#1509)', () => {
  it('maps the balances read onto cash, equity and the account currency', async () => {
    expect(await saxoFunding(clientReturning(GBP_FUNDED)).readFunding()).toEqual({
      cash: 1_000,
      equity: 1_000,
      currency: 'GBP',
    });
  });

  it('takes equity from TotalValue, not CashBalance, so deploying cash is not a drawdown', async () => {
    const deployed = { Currency: 'GBP', CashBalance: 650, TotalValue: 1_000 } as const;

    expect(await saxoFunding(clientReturning(deployed)).readFunding()).toEqual({
      cash: 650,
      equity: 1_000,
      currency: 'GBP',
    });
  });
});

describe('verifySameCurrency (#949 guard, armed only by a real read)', () => {
  it('verifies a GBP-denominated account against the GBP book', async () => {
    const funding = await saxoFunding(clientReturning(GBP_FUNDED)).readFunding();

    expect(verifySameCurrency(funding)).toEqual({
      verified: true,
      bookCurrency: 'GBP',
      accountCurrency: 'GBP',
    });
  });

  it('refuses the SIM trial account, whose balances read answers EUR (doc 44 §6.3)', async () => {
    const funding = await saxoFunding(clientReturning(SIM_TRIAL)).readFunding();

    expect(verifySameCurrency(funding)).toEqual({
      verified: false,
      bookCurrency: 'GBP',
      accountCurrency: 'EUR',
    });
  });

  it('refuses a USD account at exactly the declared book figure — the number is not the check', () => {
    expect(
      verifySameCurrency({ cash: LIVE_BOOK_GBP, equity: LIVE_BOOK_GBP, currency: 'USD' }).verified,
    ).toBe(false);
  });

  it('accepts ISO codes case-insensitively', () => {
    expect(verifySameCurrency({ cash: 1_000, equity: 1_000, currency: 'gbp' }).verified).toBe(true);
  });
});

describe('armSameCurrencyCeilings', () => {
  it('arms BOTH ceilings on a verified read, never one alone (#972 fix 3)', () => {
    const armed = armSameCurrencyCeilings(liveShapedConfig(), {
      verified: true,
      bookCurrency: 'GBP',
      accountCurrency: 'GBP',
    });

    expect(armed.live_book_ceiling?.same_currency_verified).toBe(true);
    expect(armed.per_subclass_deployment_cap?.equity_ceiling?.same_currency_verified).toBe(true);
  });

  it('leaves both refused on an unverified read', () => {
    const armed = armSameCurrencyCeilings(liveShapedConfig(), {
      verified: false,
      bookCurrency: 'GBP',
      accountCurrency: 'EUR',
    });

    expect(armed.live_book_ceiling?.same_currency_verified).toBeUndefined();
    expect(
      armed.per_subclass_deployment_cap?.equity_ceiling?.same_currency_verified,
    ).toBeUndefined();
  });

  it('does not mutate the config it is given', () => {
    const config = liveShapedConfig();
    armSameCurrencyCeilings(config, {
      verified: true,
      bookCurrency: 'GBP',
      accountCurrency: 'GBP',
    });

    expect(config.live_book_ceiling?.same_currency_verified).toBeUndefined();
  });
});

describe('assertSameCurrencyFunding (the boot refusal, ungated by any ceiling)', () => {
  it('refuses the boot when the account answers another currency', () => {
    expect(() =>
      assertSameCurrencyFunding({
        verified: false,
        bookCurrency: 'GBP',
        accountCurrency: 'EUR',
      }),
    ).toThrow(/EUR.*GBP/s);
  });

  /**
   * The check is deliberately NOT gated on a declared ceiling. A profile with
   * no ceiling is the case with the least protection downstream — every tick
   * still sizes against `readFunding`'s `equity` — so it must refuse too.
   */
  it('refuses regardless of what the risk config declares', () => {
    const noCeiling = {} as RiskConfig;
    expect(
      armSameCurrencyCeilings(noCeiling, {
        verified: false,
        bookCurrency: 'GBP',
        accountCurrency: 'EUR',
      }),
    ).toEqual(noCeiling);
    expect(() =>
      assertSameCurrencyFunding({
        verified: false,
        bookCurrency: 'GBP',
        accountCurrency: 'EUR',
      }),
    ).toThrow();
  });

  it('passes a matching account through', () => {
    expect(() =>
      assertSameCurrencyFunding({
        verified: true,
        bookCurrency: 'GBP',
        accountCurrency: 'GBP',
      }),
    ).not.toThrow();
  });
});
