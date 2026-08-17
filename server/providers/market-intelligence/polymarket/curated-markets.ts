/**
 * The curated Polymarket macro/event table (#504 scope item 2, from research
 * #481 / `docs/research/23-polymarket-source.md` §4).
 *
 * ## This table IS the design work, and it is meant to be reviewed
 *
 * Two things in each row cannot be derived from the API and are human
 * judgments:
 *
 * 1. **Which markets are worth tracking at all.** #504 says 6–10 series, and
 *    `directionFrom` (`fundamental-analyst.ts:26`) is an unweighted mean of
 *    signs — so every extra row is another equal vote, and a table that grows
 *    to fifty macro series would drown any single one that actually moved.
 * 2. **Which outcome counts as bullish for EQUITIES.** The API says a market
 *    sits at 0.295; it cannot say whether that number rising is good or bad
 *    for a long position. Every row below carries `bullishOutcome` plus the
 *    reason, in prose, so a reviewer can disagree with the annotation rather
 *    than with a bare string.
 *
 * ## Why these eight
 *
 * Measured 2026-08-17 against the live Gamma API (`/public-search`,
 * `/events?slug=`). The macro book is one to two orders of magnitude deeper
 * than anything on Samurai's own instruments — the Fed decision events alone
 * carried $1.9M of 24h volume against $805 for the whole open SPX daily market
 * in the #481 measurement — and macro is the only class of Polymarket contract
 * that is *not* a restatement of the spot price the technical analyst already
 * reads (see the module header of `polymarket-agent.ts`).
 *
 * The four Fed rows track the **hike** leg rather than the cut leg on purpose.
 * At the time of measurement the cut markets sat at 0.0035–0.0085 — a market
 * pinned at the floor cannot produce a meaningful 24h delta, so it would emit
 * `sentiment: 0` forever. The hike-25bps markets carried the live probability
 * mass (0.295 for September, on $533k of 24h volume) and are where the news
 * actually lands.
 *
 * ## Only three of these eight clear the book-quality floors TODAY
 *
 * Measured live 2026-08-17 against `MIN_VOLUME_24H_USD = 100` and
 * `MIN_LIQUIDITY_USD = 5_000` (`polymarket-agent.ts`):
 *
 * | row | 24h volume | liquidity | verdict |
 * | --- | --- | --- | --- |
 * | `fed-2026-09` | $541,447 | $572,848 | ingests |
 * | `fed-2026-10` | $1,138 | $63,554 | ingests |
 * | `fed-2026-12` | $40 | $65,341 | refused (volume) |
 * | `fed-2027-01` | absent | $29,653 | refused (volume) |
 * | `us-cpi-annual-hot-tail` | $12 | $1,886 | refused (volume + liquidity) |
 * | `us-core-cpi-mom-hot-tail` | absent | $324 | refused (volume + liquidity) |
 * | `us-recession-2026` | $35 | $40,769 | refused (volume) |
 * | `us-recession-2027` | $278 | $12,704 | ingests |
 *
 * All eight slugs resolve — nothing here has rotted yet. The refusals are the
 * fail-closed guard working, and the CPI rows in particular gain volume as the
 * print approaches, so the set is expected to widen rather than being wrong.
 * But the honest reading of this table on merge day is THREE live macro series,
 * not eight, and a row that never recovers must not decay in silence — which is
 * what the consecutive-refusal escalation in `polymarket-agent.ts#refuse` is
 * for. Whether these floors are the right floors is David's call; they are set
 * where a market's quoted probability is a price someone actually paid.
 *
 * ## Slug rot is a known, unmitigated limitation
 *
 * Polymarket mints event slugs with volatile numeric suffixes —
 * `fed-decision-in-september-762`, `fed-decision-in-october-20260617190323537`
 * — and a resolved event's replacement gets a NEW slug. So this table decays:
 * every row eventually points at an event that no longer exists, and the
 * fail-closed path in `polymarket-agent.ts` then ingests nothing for it. That
 * is the right failure (no fabricated item), but it is a SILENT one if nobody
 * looks, which is why the agent logs a `warn` naming every unresolved row on
 * every refresh rather than skipping quietly. Series-based discovery
 * (`seriesSlug` on the Gamma event payload) is the fix and is deliberately not
 * built here — #504 asks for a curated, reviewed table, and discovery would
 * put the "which markets do we trust" judgment back in the API's hands.
 */

/** The two outcome names every binary Polymarket market carries. */
export type PolymarketOutcome = 'Yes' | 'No';

/** One tracked macro series: a market, and the human annotation the API cannot give. */
export interface CuratedMacroMarket {
  /**
   * Stable, table-local id. Used in the `IntelligenceItem.id` so a row that is
   * re-pointed at a new slug (the same series, next month) keeps its identity.
   */
  id: string;
  /** Gamma event slug — `/events?slug=`. */
  eventSlug: string;
  /**
   * The ONE market within that event this row reads. #504 scope item 4: one
   * item per event, never one per outcome, because five outcome markets on one
   * Fed decision would otherwise cast five votes into an unweighted mean.
   */
  marketSlug: string;
  /**
   * Which of the market's two outcomes is bullish FOR EQUITIES. The delta is
   * measured on this outcome's token, so `sentiment = sign(delta)` is already
   * oriented for a long book.
   */
  bullishOutcome: PolymarketOutcome;
  /**
   * `IntelligenceItem.entity`. Deliberately a macro series name and never a
   * ticker: `hasCoverageFor` (`production/mi-coverage.ts`) matches
   * `item.entity === instrument`, so writing `3USL` here would light up the
   * coverage counter without the item saying anything about 3USL. That would
   * game the metric, which is worse than the gap it hides.
   */
  entity: string;
  /** Human label for the headline text. */
  label: string;
  /** Why `bullishOutcome` is the bullish side. Reviewed prose, not a comment. */
  rationale: string;
}

/**
 * The tracked set. Eight rows: four Fed decisions, two US CPI tails, two US
 * recession horizons.
 */
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
    id: 'us-cpi-annual-hot-tail',
    eventSlug: 'august-inflation-us-annual-1786474662954',
    marketSlug: 'will-annual-inflation-be-4pt0-or-more-in-august-1786474663065',
    bullishOutcome: 'No',
    entity: 'US-CPI-YOY',
    label: 'P(US annual CPI NOT 4.0%+)',
    rationale:
      'The top bucket of the ladder is the hot-print tail. A rising probability of a 4%+ ' +
      'annual print raises the odds of a tighter policy response, which is bearish. The tail ' +
      'is chosen over a middle bucket because a middle bucket has no direction at all — its ' +
      'probability rises both when the consensus cools and when it heats toward that bucket.',
  },
  {
    id: 'us-core-cpi-mom-hot-tail',
    eventSlug: 'core-cpi-mom-august-2026-1786474662954',
    marketSlug: 'will-core-cpi-mom-be-0pt6-or-more-in-august-1786474663160',
    bullishOutcome: 'No',
    entity: 'US-CORE-CPI-MOM',
    label: 'P(US core CPI MoM NOT 0.6%+)',
    rationale: 'The same hot-tail argument as the annual row, on the monthly core series.',
  },
  {
    id: 'us-recession-2026',
    eventSlug: 'us-recession-by-end-of-2026',
    marketSlug: 'us-recession-by-end-of-2026',
    bullishOutcome: 'No',
    entity: 'US-RECESSION-2026',
    label: 'P(no US recession by end of 2026)',
    rationale:
      'A rising recession probability is bearish for a long equity book. Stated with the ' +
      'caveat this file cannot resolve: the same item reaches SGLN (gold) through the ' +
      'asset-class filter, where a recession bid is plausibly BULLISH. The contract carries ' +
      'no per-instrument direction — see the limitation in polymarket-agent.ts.',
  },
  {
    id: 'us-recession-2027',
    eventSlug: 'us-recession-by-end-of-2027-20260807185409760',
    marketSlug: 'us-recession-by-end-of-2027-20260807185409760',
    bullishOutcome: 'No',
    entity: 'US-RECESSION-2027',
    label: 'P(no US recession by end of 2027)',
    rationale: 'Same as the 2026 row, one year further out.',
  },
];
