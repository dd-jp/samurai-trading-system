
type PolymarketOutcome = 'Yes' | 'No';

export interface CuratedMacroMarket {
  id: string;
  eventSlug: string;
  marketSlug: string;
  bullishOutcome: PolymarketOutcome;
  entity: string;
  label: string;
  rationale: string;
}

export const CURATED_MACRO_MARKETS: readonly CuratedMacroMarket[] = [
  {
    id: 'fed-2026-09',
    eventSlug: 'fed-decision-in-september-762',
    marketSlug:
      'will-the-fed-increase-interest-rates-by-25-bps-after-the-september-2026-meeting-649',
    bullishOutcome: 'No',
    entity: 'FOMC-2026-09',
    label: 'P(no 25bp hike at the September 2026 FOMC)',
    rationale:
      'A rising probability of a hike is a rising discount rate and a tighter policy path, ' +
      'which is bearish for a levered long equity book. "No" is therefore the bullish side.',
  },
  {
    id: 'fed-2026-10',
    eventSlug: 'fed-decision-in-october-20260617190323537',
    marketSlug:
      'will-the-fed-increase-interest-rates-by-25-bps-after-the-october-2026-meeting-20260617190324032',
    bullishOutcome: 'No',
    entity: 'FOMC-2026-10',
    label: 'P(no 25bp hike at the October 2026 FOMC)',
    rationale: 'Same as the September row, one meeting further out.',
  },
  {
    id: 'fed-2026-12',
    eventSlug: 'fed-decision-in-december-20260729232808632',
    marketSlug:
      'will-the-fed-increase-interest-rates-by-25-bps-after-the-december-2026-meeting-20260729232808636',
    bullishOutcome: 'No',
    entity: 'FOMC-2026-12',
    label: 'P(no 25bp hike at the December 2026 FOMC)',
    rationale: 'Same as the September row, carrying the end-of-year policy path.',
  },
  {
    id: 'fed-2027-01',
    eventSlug: 'fed-decision-in-january-20260729233815502',
    marketSlug:
      'will-the-fed-increase-interest-rates-by-25-bps-after-the-january-2027-meeting-20260729233815506',
    bullishOutcome: 'No',
    entity: 'FOMC-2027-01',
    label: 'P(no 25bp hike at the January 2027 FOMC)',
    rationale: 'Same as the September row, the first meeting of the next calendar year.',
  },
  {
    id: 'ru-ua-ceasefire-2026',
    eventSlug: 'russia-x-ukraine-ceasefire-agreement-by',
    marketSlug: 'russia-x-ukraine-ceasefire-agreement-by-december-31-2026',
    bullishOutcome: 'Yes',
    entity: 'RU-UA-CEASEFIRE-2026',
    label: 'P(Russia x Ukraine ceasefire agreement by December 31, 2026)',
    rationale:
      'A ceasefire resolves the war-risk premium sitting in energy prices and risk sentiment ' +
      'generally, so a rising probability is bullish for a long equity book. "Yes" is ' +
      'therefore the bullish side. Stated with the same caveat the row it replaced carried: the ' +
      'same item reaches SGLN (gold) through the asset-class filter, where a ceasefire is ' +
      'plausibly BEARISH — a war-risk safe-haven bid unwinding. The contract carries no ' +
      'per-instrument direction — see the limitation in polymarket-agent.ts.',
  },
  {
    id: 'hormuz-traffic-2026',
    eventSlug: 'strait-of-hormuz-traffic-returns-to-normal-by-december-31',
    marketSlug: 'strait-of-hormuz-traffic-returns-to-normal-by-december-31',
    bullishOutcome: 'Yes',
    entity: 'HORMUZ-TRAFFIC-2026',
    label: 'P(Strait of Hormuz traffic returns to normal by December 31, 2026)',
    rationale:
      'A Strait of Hormuz disruption is an oil-supply shock; traffic normalizing removes that ' +
      'tail risk, so a rising probability is bullish for a long equity book. "Yes" is ' +
      'therefore the bullish side. Stated with the same caveat the row it replaced carried: the ' +
      'same item reaches SGLN (gold) through the asset-class filter, where normalizing traffic ' +
      'is plausibly BEARISH — a supply-shock safe-haven bid unwinding. The contract carries no ' +
      'per-instrument direction — see the limitation in polymarket-agent.ts.',
  },
];
