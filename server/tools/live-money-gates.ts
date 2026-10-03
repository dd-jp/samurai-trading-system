export const LIVE_MONEY_GATES: readonly { readonly issue: number; readonly gap: string }[] = [
  {
    issue: 895,
    gap: 'the live equity leg still has no chosen mark vendor — the LseMarkDataSource seam exists but the composition root has no client to hand it, so a live LSE boot refuses by design; no source this repo integrates lists an LSE ticker (Alpaca and Polygon both VERIFIED absent), and doc 34 recommends IBKR LSE UK L1 as the only retail-priced real-time LSE Level 1 feed with bid/ask found',
  },
];

export const LIVE_MONEY_GATES_VERIFIED_ON = '2026-10-03';

export const LIVE_MONEY_GATES_RECHECK_COMMAND = 'npm run check:live-gates';
