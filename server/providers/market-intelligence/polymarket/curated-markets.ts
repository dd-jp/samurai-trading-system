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
 *    `directionFrom` (`fundamental-analyst.ts`) is an unweighted mean of
 *    signs — so every extra row is another equal vote, and a table that grows
 *    too large would drown any single one that actually moved.
 * 2. **Which outcome counts as bullish for EQUITIES.** The API cannot say
 *    whether a rising probability is good or bad for a long position. Every
 *    row below carries `bullishOutcome` plus the reason in prose, so a
 *    reviewer can disagree with the annotation rather than with a bare
 *    string.
 *
 * ## Why these six
 *
 * The macro book is deeper than anything on Samurai's own instruments, and
 * macro is the only class of Polymarket contract that is not a restatement
 * of the spot price the technical analyst already reads (see the module
 * header of `polymarket-agent.ts`). The four Fed rows track the **hike** leg
 * rather than the cut leg: the cut markets sit pinned near the floor, where a
 * contract cannot produce a meaningful 24h delta (`MIN_PROBABILITY_HEADROOM`
 * in `polymarket-agent.ts`), so it would emit `sentiment: 0` forever.
 *
 * ## Not every row ingests on every probe, by design
 *
 * The book-quality floors (`MIN_VOLUME_24H_USD`, `MIN_LIQUIDITY_USD` in
 * `polymarket-agent.ts`) refuse thin rows at runtime, and which rows clear
 * them shifts hour to hour with volume — so the live ingesting subset is a
 * per-probe fact, not a property of the table. That is the fail-closed guard
 * working, not a defect, and it is why several rows are the SAME macro view
 * one meeting apart: under `directionFrom`'s unweighted mean, one view can
 * cast two or three of the live votes (the cross-row half of the
 * vote-inflation limitation recorded in `polymarket-agent.ts`).
 *
 * A row that never recovers must not decay in silence, which is what the
 * consecutive-refusal escalation in `polymarket-agent.ts#refuse` is for, and
 * why that escalation is persisted through `MiArchiveStore` (migration
 * 0004) rather than kept in memory — a soak that restarts more than once a
 * day must still accumulate past `REFUSAL_WARN_STREAK` instead of resetting.
 *
 * ## Pinned rows are removed, not left to wait (#833)
 *
 * Two CPI rows (`us-cpi-annual-hot-tail`, `us-core-cpi-mom-hot-tail`) were
 * removed after their bullish legs measured past 0.97: under
 * `directionFrom`'s unweighted mean, a contract pinned this close to
 * certainty casts a permanent zero vote that dilutes every row that does
 * move — the opposite of the "we looked and it did not move" observation
 * #504 decision 7 protects. More volume would only make a pinned row worse,
 * not rescue it, so re-pointing a ladder-style series at a bucket with real
 * headroom is a judgment call left for a reviewer, not guessed at here. The
 * durable guard is `MIN_PROBABILITY_HEADROOM`, which refuses any row at
 * runtime rather than relying on catching pinned rows at review time.
 *
 * ## #1120: the two recession rows replaced
 *
 * `us-recession-2026` and `us-recession-2027` were dropped: one drifted into
 * the same permanent-pinned state the CPI rows did, and the other never
 * durably cleared the volume floor. Replaced rather than re-pointed at
 * another recession horizon, since a market priced against a fixed year-end
 * deadline structurally hardens as the deadline nears — a third
 * recession-by-date row would only defer the same failure. The replacements
 * are event risk from a DIFFERENT macro driver than the four Fed rows, so
 * the table's cross-row vote-inflation limitation is not made worse.
 *
 * **`ru-ua-ceasefire-2026`** tracks the Gamma event's December-31-2026
 * market (one of five horizons on the same event — #504 scope item 4 still
 * means picking one market, not one per horizon). A ceasefire resolves the
 * war-risk premium sitting in energy prices and risk sentiment generally, so
 * rising P(ceasefire) is BULLISH for equities.
 *
 * **`hormuz-traffic-2026`** tracks whether Strait-of-Hormuz shipping
 * normalizes by the same year-end deadline the recession rows used to
 * carry. Hormuz disruption is an oil-supply shock; traffic normalizing
 * removes that tail risk, so rising P(Yes) is BULLISH.
 *
 * ## Slug rot is a known, unmitigated limitation
 *
 * Polymarket mints event slugs with volatile numeric suffixes, and a
 * resolved event's replacement gets a NEW slug — so every row eventually
 * points at an event that no longer exists. The fail-closed path in
 * `polymarket-agent.ts` then ingests nothing for it (the right failure, no
 * fabricated item), and logs a `warn` naming the row so it isn't silent.
 * Series-based discovery (`seriesSlug` on the Gamma event payload) is the
 * fix and is deliberately not built here — #504 asks for a curated,
 * reviewed table, and discovery would put the "which markets do we trust"
 * judgment back in the API's hands.
 */

/** The two outcome names every binary Polymarket market carries */
type PolymarketOutcome = 'Yes' | 'No';

/** One tracked macro series: a market, and the human annotation the API cannot give */
export interface CuratedMacroMarket {
  /**
   * Stable, table-local id. Used in the `IntelligenceItem.id` so a row that is
   * re-pointed at a new slug (the same series, next month) keeps its identity.
   */
  id: string;
  /** Gamma event slug — `/events?slug=` */
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
  /** Human label for the headline text */
  label: string;
  /** Why `bullishOutcome` is the bullish side. Reviewed prose, not a comment. */
  rationale: string;
}

/**
 * The tracked set. Six rows: four Fed decisions and two geopolitical event
 * risks (#1120 replaced the two US recession horizons — see that section
 * above). #504 asks for 6–10 series, so this sits at the floor of that range
 * after #833 removed the two pinned CPI tails.
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
    // #1120 replaced `us-recession-2026` (pinned past MIN_PROBABILITY_HEADROOM)
    // with this row — see "#1120: the two recession rows replaced" above
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
    // #1120 replaced `us-recession-2027` (never durably cleared the volume
    // floor) with this row
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
