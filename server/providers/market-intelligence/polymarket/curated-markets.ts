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
 * ## Why these six
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
 * ## Only about half of these six ingest on any given probe
 *
 * Measured live 2026-08-17 against `MIN_VOLUME_24H_USD = 100` and
 * `MIN_LIQUIDITY_USD = 5_000` (`polymarket-agent.ts`):
 *
 * | row | 24h volume | liquidity | P(bullish leg) | verdict |
 * | --- | --- | --- | --- | --- |
 * | `fed-2026-09` | $541,447 | $572,848 | 0.705 | ingests |
 * | `fed-2026-10` | $1,138 | $63,554 | 0.765 | ingests |
 * | `fed-2026-12` | $40 | $65,341 | 0.755 | refused (volume) |
 * | `fed-2027-01` | absent | $29,653 | 0.800 | refused (volume) |
 * | `us-recession-2026` | $35 | $40,769 | 0.925 | refused (volume, and pinned) |
 * | `us-recession-2027` | $278 | $12,704 | 0.725 | ingests |
 *
 * Every slug resolves — nothing here has rotted yet. The refusals are the
 * fail-closed guard working. But the honest reading of this table on merge day
 * is THREE live macro series, not six.
 *
 * Re-probed 2026-08-18 (#833), and the volume column MOVES: `fed-2026-12` was
 * at $2,773 and `us-recession-2026` at $763 — both above `MIN_VOLUME_24H_USD`
 * — while `us-recession-2027` had fallen to $3.23 and `fed-2027-01` still
 * reported none. So the count stayed at three ingesting rows, but not the same
 * three. Do not read the verdict column as a standing fact; read it as one
 * probe. The probabilities barely moved over that day (0.715, 0.765, 0.755,
 * 0.800, 0.925, 0.725), which is the point of the next section: volume is what
 * changes hour to hour, and volume is what lets a pinned row start emitting.
 *
 * ## The two CPI rows were REMOVED, and pinning is now a guard (#833)
 *
 * The table shipped with `us-cpi-annual-hot-tail` and
 * `us-core-cpi-mom-hot-tail`. Measured on the same 2026-08-17 probe their
 * bullish legs sat at 0.9945 and 0.9755 — the SAME disqualifier this file uses
 * to reject the Fed cut leg above, mirrored. Volume arriving later would not
 * have rescued them: it would have made them WORSE, because clearing the
 * book-quality floors is what starts a row emitting, and a contract with
 * 0.0055 of headroom emits `sentiment: 0, confidence: 0.05` every hour
 * forever. `directionFrom` and `confidenceFrom` (`fundamental-analyst.ts`) are
 * unweighted means, so that is a permanent zero vote diluting every row that
 * did move — not the "we looked and it did not move" observation #504's
 * decision 7 protects. Both rows are gone, and re-pointing the CPI series at a
 * ladder bucket with real headroom is left open rather than guessed at here.
 * Note what makes it a judgment and not a lookup: the removed rows tracked the
 * ladder's hot TAIL precisely because a middle bucket has no direction at all
 * — its probability rises both when the consensus cools toward it and when it
 * heats toward it — so "pick a bucket nearer 0.5" is not automatically a
 * better row, and a reviewer has to weigh headroom against directionality.
 *
 * Deleting two rows would not stop the next one, so the durable half of the
 * fix is `MIN_PROBABILITY_HEADROOM` in `polymarket-agent.ts` — every row, every
 * pass, is refused unless `min(p, 1 - p) >= 0.10`. That is a runtime check
 * because `p` is a live quote; there is nothing in this file to test at build
 * time.
 *
 * `us-recession-2026` was, at this point, KEPT despite sitting at 0.925 —
 * headroom 0.075, inside the bound — on the bet that PLAUSIBLE RETURN TO RANGE
 * (months left to run, unlike a CPI print days from resolution) would
 * eventually pull it back over the line rather than the CPI tails' one-way
 * hardening. **#1120 is that bet called**: re-measured 2026-09-04 the row had
 * drifted the other way, to 0.935 (headroom 0.065), and `consecutive_refusals`
 * had reached 12 in one process's lifetime with no sign of recovery — the
 * exact permanent-zero-vote state this section predicted #833's guard would
 * have to catch. See "#1120: the two recession rows replaced" below for the
 * resolution: both `us-recession-2026` and `us-recession-2027` are gone.
 *
 * WHICH rows both clear book quality and have room to move is a per-probe
 * fact, not a property of the table. On 2026-08-17 it was `fed-2026-09`
 * (0.705), `fed-2026-10` (0.765) and `us-recession-2027` (0.725); on 2026-08-18
 * `us-recession-2027` had dropped to $3.23 of volume and `fed-2026-12` had
 * risen past the floor. Both probes agree on the count — THREE — and on the
 * shape of the problem: the Fed rows dominate it, and several of them are the
 * SAME macro view one meeting apart, so under `directionFrom`'s unweighted
 * mean one view can cast two or three of the live votes. That is the cross-row
 * half of the vote-inflation limitation recorded in `polymarket-agent.ts`.
 *
 * A row that never recovers must not decay in silence, which is what the
 * consecutive-refusal escalation in `polymarket-agent.ts#refuse` is for — and,
 * since #1120, what makes that escalation survive a process restart: the
 * streak is now persisted through `MiArchiveStore` (migration 0004), so a soak
 * that bounces more than once a day still accumulates past
 * `REFUSAL_WARN_STREAK` instead of resetting to 1 on every restart.
 * Whether these floors are the right floors is David's call; they are set where
 * a market's quoted probability is a price someone actually paid.
 *
 * ## #1120: the two recession rows replaced
 *
 * `us-recession-2026`'s bet did not pay off (see above) and `us-recession-2027`
 * never cleared the volume floor for long: its 24h volume swung from $278
 * (2026-08-17) to $3.23 (2026-08-18) to $258.58 (2026-09-05, live-checked while
 * fixing this issue) — thin enough that a full day of hourly polls landing on
 * the wrong side of $100 is unsurprising, not anomalous. Both were refusing on
 * every poll `consecutive_refusals` had a record of as of 2026-09-04.
 *
 * Replaced rather than re-pointed at another recession horizon: a market
 * priced against a fixed year-end deadline structurally hardens as the
 * deadline nears (the CPI tails' failure mode, and now this one's), so a THIRD
 * recession-by-date row would only defer the same problem. The replacements
 * are event risk from a DIFFERENT macro driver than every surviving row (the
 * four Fed rows are one interest-rate view measured four ways) so the table's
 * cross-row vote-inflation limitation is not made worse:
 *
 * | row | eventSlug | bullish price | 24h volume | liquidity | verdict (2026-09-05) |
 * | --- | --- | --- | --- | --- | --- |
 * | `ru-ua-ceasefire-2026` | `russia-x-ukraine-ceasefire-agreement-by` (Dec 31, 2026 market) | 0.265 | $219,232 | $116,303 | ingests |
 * | `hormuz-traffic-2026` | `strait-of-hormuz-traffic-returns-to-normal-by-december-31` | 0.265 | $40,237 | $432,446 | ingests |
 *
 * **`ru-ua-ceasefire-2026`** tracks the Gamma event's December-31-2026 market
 * (of five horizons on the same event, from May 2026 to June 2027 — #504 scope
 * item 4 still means picking the one market, not one per horizon). A ceasefire
 * resolves the war-risk premium sitting in energy prices and risk sentiment
 * generally, so rising P(ceasefire) is BULLISH for equities; `bullishOutcome`
 * is therefore `'Yes'`.
 *
 * **`hormuz-traffic-2026`** tracks whether Strait-of-Hormuz shipping normalizes
 * by the same year-end deadline the recession rows used to carry, which keeps
 * this table's overall time-decay character unchanged. Hormuz disruption is an
 * oil-supply shock; traffic returning to normal removes that tail risk, so
 * rising P(Yes) is BULLISH. `bullishOutcome` is `'Yes'`.
 *
 * Both prices sit at 0.265 — the same live 2026-09-05 measurement, a
 * coincidence of the day, not a property of either market — for 0.265 of
 * headroom, well clear of `MIN_PROBABILITY_HEADROOM` (0.10), and both cleared
 * `MIN_VOLUME_24H_USD`/`MIN_LIQUIDITY_USD` by one to two orders of magnitude
 * rather than the single-digit margins `us-recession-2027` lived on — the
 * `fed-2026-12`/`fed-2027-01` book-quality margins in the table above are the
 * same kind of thin this change was trying to move away from, and it does not
 * touch those rows because the acceptance criteria named these two.
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
    // #1120 replaced `us-recession-2026` (pinned at 0.935, 0.065 of headroom —
    // below MIN_PROBABILITY_HEADROOM) with this row. See "#1120: the two
    // recession rows replaced" above for the live evidence and why a
    // different macro driver was chosen over another recession horizon
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
    // #1120 replaced `us-recession-2027` (24h volume swinging from $278 to
    // $3.23 to $258.58 across three probes — never durably above the $100
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
