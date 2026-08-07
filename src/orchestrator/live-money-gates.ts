/**
 * The open gates between this system and real money, in ONE place (#511).
 *
 * ## Why this is a module and not a sentence in two files
 *
 * Two callers state it: `paperStartingProfile`'s live refusal (paper-profile.ts)
 * and `liveStartingProfile`'s startup warning (live-profile.ts). Written twice,
 * one of them becomes wrong the first time a gate closes — and this repo has
 * the receipts. The refusal these replace cited
 * [#384](https://github.com/dd-jp/samurai-trading-system/issues/384),
 * [#375](https://github.com/dd-jp/samurai-trading-system/issues/375) and
 * [#333](https://github.com/dd-jp/samurai-trading-system/issues/333) as "three
 * breakers that cannot fire". All three were closed by the time anyone read it
 * again, so the refusal was justifying itself on grounds that no longer held,
 * in a checkable way, which is the worst kind: the next reader trusts it.
 *
 * ## The rule for editing this list
 *
 * **Verify state before citing.** `gh issue view <N>` and confirm the issue is
 * OPEN and says what the line claims, every time this list is touched. An issue
 * number in a safety message is a claim about the world, not decoration.
 *
 * **A closed issue is deleted, not struck through.** The list's value is that
 * an operator can act on it; a graveyard entry costs them the read.
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
 * Kept as data rather than prose so the two callers render one list and a test
 * can assert that no entry has silently become a bare number with no claim
 * attached to it.
 */
export const LIVE_MONEY_GATES: readonly { readonly issue: number; readonly gap: string }[] = [
  {
    issue: 526,
    gap: 'the Alpaca flattens sweep map is in-memory, so a crash drops a flatten off the fill worklist',
  },
  {
    issue: 519,
    gap: 'nothing sweeps the flatten_submissions journal, so a lost-response flatten is recorded but never resolved',
  },
  {
    issue: 548,
    gap: "AlpacaBrokerAdapter's re-armed-legs sweep is in-memory, so a restart drops a re-armed OCO off the fill worklist",
  },
  {
    issue: 549,
    gap: 'a crash between a partial-flatten exit fill and its re-arm leaves a residual naked, with no retry and no alert',
  },
  {
    issue: 550,
    gap: 'Alpaca OCO — the re-arm order — is unverified for crypto symbols',
  },
  {
    issue: 551,
    // Deliberately does not cite the (closed) ticket that added the alert: a
    // number in this list reads as "still open", and mixing provenance
    // citations into it is how the last stale refusal happened.
    gap: 'the residual-exposure alert has no transport wired through SAMURAI_ALERTS, so it reaches nobody',
  },
  {
    issue: 562,
    gap: 'the live orchestrator has no OHLCV failover — one vendor serves every bar it reads',
  },
];

/** The date every entry above was checked against GitHub. */
export const LIVE_MONEY_GATES_VERIFIED_ON = '2026-08-07';

/**
 * The gate list as one sentence, for an error message or a log line.
 *
 * Leads with the reason that cannot go stale and dates the numbered part, so a
 * reader who finds the numbers closed still has the standing reason and knows
 * exactly how old the rest is.
 */
export const LIVE_MONEY_GATE_SUMMARY: string =
  'The reason that does not depend on any bug number: the 14-day paper soak (#238) that ' +
  'would produce the observations these values are meant to be tuned against has not run, ' +
  `so every UNSOURCED value in the starting profile is still a guess. As of ` +
  `${LIVE_MONEY_GATES_VERIFIED_ON}, ${LIVE_MONEY_GATES.length} further issues were verified ` +
  `OPEN and gate live money: ` +
  LIVE_MONEY_GATES.map(({ issue, gap }) => `#${issue} (${gap})`).join('; ') +
  '. Re-check their state before trusting this list.';
