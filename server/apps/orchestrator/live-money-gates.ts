/**
 * The open gates between this system and real money, in ONE place (#511).
 *
 * ## Why this is a module and not a sentence in two files
 *
 * Two callers state it: `paperStartingProfile`'s live refusal (paper-profile.ts)
 * and `liveStartingProfile`'s startup warning (live-profile.ts). Written twice,
 * one of them becomes wrong the first time a gate closes — and a checkable
 * claim that is wrong is the worst kind, because the next reader trusts it.
 * One list, so both callers go stale together or not at all.
 *
 * ## The rule for editing this list
 *
 * **Verify state before citing.** `yarn check:live-gates` (or `gh issue view <N>`
 * one at a time) and confirm the issue is OPEN and says what the line claims,
 * every time this list is touched. An issue number in a safety message is a
 * claim about the world, not decoration. Bump `LIVE_MONEY_GATES_VERIFIED_ON` in
 * the same edit — the date is the only thing telling the next reader how much
 * of the list to trust.
 *
 * **A closed issue is deleted, not struck through.** The list's value is that
 * an operator can act on it; a graveyard entry costs them the read.
 *
 * **Adding an entry means commenting on that issue too**, saying it is cited
 * here and that closing it makes this list wrong. That comment is the only
 * thing that reaches the person who closes the issue, who has no reason to know
 * this file exists — see the #868 note below. An entry added without one
 * re-creates exactly the silent decay this list has already suffered once.
 *
 * **Every entry states why it gates a LIVE BOOT**, not merely that it is open.
 * The discriminator is whether it changes what the operator should do at the
 * moment they flip `SAMURAI_MODE=live`. An open ticket that does not is noise
 * here, and noise is how the previous list became unreadable.
 *
 * ## Why nothing in `yarn test` asserts these are still open (#868)
 *
 * The list went 7-for-7 stale between 2026-08-07 and 2026-08-18 and nothing
 * noticed, so the obvious fix is a test that asserts each cited issue is OPEN.
 * That test cannot exist here, for two reasons that are facts about this repo
 * rather than judgement calls:
 *
 *  1. **"Is issue N open" is not a property of this tree.** It changes with no
 *     file changing, so no checkout-deterministic check can hold it. The suite
 *     makes no real network calls, and a check whose answer depends on ambient
 *     state that varies by machine is a check people learn to disable — that is
 *     #866's finding about `check-path-citations`, and a `gh`-shelling test
 *     would reproduce it with authentication in place of a `data/` directory.
 *  2. **A scheduled task would never run.** GitHub Actions is billing-blocked
 *     on this repo: every job fails in ~3s with 0 steps. A cron check is a
 *     mechanism that exists and does nothing, which is worse than none.
 *
 * A clock-triggered variant — fail the suite once `LIVE_MONEY_GATES_VERIFIED_ON`
 * is older than N days — was considered and rejected for the same reason: it
 * reddens unrelated work at an arbitrary moment, which is the disable-magnet
 * shape again.
 *
 * So the decay is made **loud and cheap to settle** instead of silently
 * checked. The rendered summary carries the verification date and names the
 * one command that answers the question — `yarn check:live-gates`
 * (`server/tools/check-live-money-gates.ts`), which reads this same list, asks
 * GitHub for each issue's state, and exits non-zero if any cited issue has
 * closed. It is operator- and maintainer-invoked, deliberately NOT wired into
 * `lint`/`typecheck`/`test`/`smoke`. Each cited issue also carries a pointer
 * comment saying it is cited here, so the person closing it is told by the
 * artifact they are already reading.
 *
 * ## What is deliberately NOT in the list
 *
 * The reason live money is unsafe that does not depend on any of these: **no
 * 14-day paper soak has run** ([#238](https://github.com/dd-jp/samurai-trading-system/issues/238),
 * open), so every value labelled `UNSOURCED` in the starting profile is still a
 * guess, and since ADR-0007 removed the human gate those guesses are the only
 * thing between a bad debate and the account. That sentence stays true until
 * the soak happens, which is why both callers lead with it and treat the
 * numbered list as supporting detail.
 */

/**
 * Open issues that gate live money, each verified OPEN on the date below.
 *
 * Kept as data rather than prose so the two callers render one list, so a test
 * can assert that no entry has silently become a bare number with no claim
 * attached to it, and so `yarn check:live-gates` can re-verify the whole list
 * against GitHub without re-parsing an English sentence.
 */
export const LIVE_MONEY_GATES: readonly { readonly issue: number; readonly gap: string }[] = [
  {
    issue: 665,
    // Verified OPEN 2026-08-19: `gh issue view 665`. Replaces the #734 entry,
    // which closed with the LSE mark SEAM built but its vendor unchosen — the
    // seam is not the gate, the vendor is. Cited here rather than #666 because
    // #666 is a measurement on the T212 demo API, and doc 34 §4 found that API
    // cannot serve a mark at all (no quote endpoint, no timestamp on the one
    // price field, and API Terms 4.2(a) prohibiting algorithmic trading) —
    // so the open question is the venue/vendor itself, which is #665's.
    gap: 'the live equity leg still has no chosen mark vendor — the LseMarkDataSource seam exists but the composition root has no client to hand it, so a live LSE boot refuses by design; doc 34 recommends IBKR LSE UK L1 and records that the T212 API can neither quote nor lawfully be automated',
  },
  {
    issue: 888,
    // Verified OPEN 2026-08-19: `gh issue view 888`. Arming-blocking on the
    // issue itself. Note this profile's ceiling env var is named
    // SAMURAI_LIVE_MAX_CAPITAL_USD — USD — against a GBP book.
    //
    // This entry was #800 until 2026-08-19. #800 named the 2x denominator
    // disagreement, which PR #885 RESOLVED and which auto-closed #800 on merge
    // — leaving this list citing a closed issue, the exact staleness the module
    // doc forbids. The gap that survived #800 is split out as #888 so the
    // citation points at something open. A closed issue is deleted, not
    // struck through.
    gap: 'portfolio.equity is one blended GET /v2/account figure with no per-leg accounting, so every D5 envelope is correct only while the funded equity equals the declared book — fund the ISA past it and the same fractions authorise proportionally more cash than the book was sized for',
  },
  {
    issue: 886,
    // Verified OPEN 2026-08-19: `gh issue view 886`. Labelled BLOCKING(arming)
    // on the issue itself. Cited here per this module's own rule; see the
    // comment left on #886 recording the citation.
    gap: 'per_trade_size_cap is a STATIC cash figure derived from the boot ceiling while the D5 envelope is a live fraction of portfolio.equity, so which one binds depends on how far equity sits below that ceiling — the two caps are not comparable as fractions and neither side of the pair is reliably the operative limit on an entry',
  },
  {
    issue: 798,
    // Verified OPEN 2026-08-19: `gh issue view 798`.
    gap: "ADR-0018 D5's declared brackets imply a ~41.8% single-stock envelope against a ~20-25% tolerance, so the sizing this profile ships is unreconciled with the drawdown envelope it was sized against",
  },
  {
    issue: 826,
    // Verified OPEN 2026-08-19: `gh issue view 826`. The live successor to the
    // closed #562 — the failover gap moved from bars to marks and quotes, it
    // did not clear.
    gap: 'marks and quotes are not failed over, so a single Alpaca outage stops the tick at the mark read with positions open',
  },
];

/**
 * The date every entry above was checked against GitHub.
 *
 * Bump this in the same edit that touches `LIVE_MONEY_GATES`, never separately:
 * a date newer than the last verification is a false claim in an operator-facing
 * safety message, and a date older than the list is what #868 was filed about.
 */
export const LIVE_MONEY_GATES_VERIFIED_ON = '2026-08-19';

/** The command that re-verifies the list, named in the operator-facing summary. */
export const LIVE_MONEY_GATES_RECHECK_COMMAND = 'yarn check:live-gates';

/**
 * The gate list as one sentence, for an error message or a log line.
 *
 * Leads with the reason that cannot go stale, dates the numbered part, and — the
 * #868 change — hands the reader the one command that settles whether the dated
 * part is still true. "Re-check their state before trusting this list" was true
 * advice with no way to act on it; a reader who has to hand-check seven issue
 * numbers checks none.
 */
export const LIVE_MONEY_GATE_SUMMARY: string =
  'The reason that does not depend on any bug number: the 14-day paper soak (#238) that ' +
  'would produce the observations these values are meant to be tuned against has not run, ' +
  `so every UNSOURCED value in the starting profile is still a guess. As of ` +
  `${LIVE_MONEY_GATES_VERIFIED_ON}, ${LIVE_MONEY_GATES.length} further issues were verified ` +
  `OPEN and gate live money: ` +
  LIVE_MONEY_GATES.map(({ issue, gap }) => `#${issue} (${gap})`).join('; ') +
  `. That verification is a snapshot taken on ${LIVE_MONEY_GATES_VERIFIED_ON}, not a live ` +
  `fact: nothing re-checks it automatically. Run \`${LIVE_MONEY_GATES_RECHECK_COMMAND}\` to ` +
  're-verify every number above against GitHub before trusting this list.';
