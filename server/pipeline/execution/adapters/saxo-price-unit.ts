export interface SaxoQuoteUnit {
  readonly price_to_contract_factor: number;
}

export function saxoCashPerShare(unit: SaxoQuoteUnit, quotedPrice: number): number {
  return quotedPrice * unit.price_to_contract_factor;
}

export function saxoQuotedPrice(unit: SaxoQuoteUnit, cashPrice: number): number {
  return cashPrice / unit.price_to_contract_factor;
}
