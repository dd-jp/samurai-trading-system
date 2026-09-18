
export const BOOK_CURRENCY = 'GBP';

const PENCE_CODES: readonly string[] = ['GBX', 'gbx', 'GBp', 'p'];

export function isPenceCurrency(currency: string): boolean {
  return PENCE_CODES.includes(currency.trim());
}

export function isBookCurrency(currency: string): boolean {
  const code = currency.trim();
  return isPenceCurrency(code) || code.toUpperCase() === BOOK_CURRENCY;
}
