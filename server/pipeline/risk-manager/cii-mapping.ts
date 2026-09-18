const INSTRUMENT_COUNTRY: Record<string, string> = {
  YNDX: 'RU',
  MBT: 'RU',
  ARAMCO: 'SA',
  BABA: 'CN',
  JD: 'CN',
};

export function countryForInstrument(instrument: string): string | null {
  return INSTRUMENT_COUNTRY[instrument] ?? null;
}

export function trackedCountries(): string[] {
  return [...new Set(Object.values(INSTRUMENT_COUNTRY))];
}
