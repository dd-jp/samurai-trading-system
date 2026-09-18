
export const LIVE_MONEY_GATES: readonly { readonly issue: number; readonly gap: string }[] = [
  {
    issue: 895,
    gap: 'the live equity leg still has no chosen mark vendor — the LseMarkDataSource seam exists but the composition root has no client to hand it, so a live LSE boot refuses by design; no source this repo integrates lists an LSE ticker (Alpaca and Polygon both VERIFIED absent), and doc 34 recommends IBKR LSE UK L1 as the only retail-priced real-time LSE Level 1 feed with bid/ask found',
  },
  {
    issue: 900,
    gap: 'a data-source outage leaves the book able to take exactly ONE action — quotes are not failed over at all, and every entry plus both discretionary exits (signal_decay, direction_flip) still stop the tick at the mark read, so the clock-driven flat-by-close flatten is the only decision that completes while a vendor is down',
  },
];

export const LIVE_MONEY_GATES_VERIFIED_ON = '2026-08-31';

export const LIVE_MONEY_GATES_RECHECK_COMMAND = 'npm run check:live-gates';

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
