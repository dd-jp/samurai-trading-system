# Alpaca paper OCO re-arm probe, 2026-11-20

Refs #2090. Verdict: **PASSED**.

One `npm run v2:alpaca-oco-probe` run on Alpaca **paper** (`https://paper-api.alpaca.markets`), approved by David on #2090 (2026-11-19, "go probe") and run in US regular hours, 2026-11-20 14:42:42Z to 14:42:56Z. Full record: alpaca-oco-probe-2026-11-20T144242Z.json.

## Steps

1. A bracket buy of 1 SCHD at limit 34.73 (ask 34.56), with stop 32.99 and target 36.47, filled at 34.56. The bracket's stop leg rested `held` and its take-profit `new`, as measured on 2026-10-07 (#2086). The reconcile was clean.
2. The ledger's stop was moved to 32.30. The reconcile then reported one `protective_price` diff (store 32.3, broker 32.99), as it should.
3. The re-arm cancelled the bracket's legs and placed an OCO for the held quantity (1): a take-profit limit sell at 36.47 and a stop at 32.30. The reconcile was clean.
4. Cleanup cancelled both OCO orders and flattened with a market sell. Afterwards: position 0, working orders none.

## Measured OCO re-arm wire

- **Parent:** `order_class: oco`, `type: limit`, `side: sell`, `position_intent: sell_to_close`, `time_in_force: gtc`, `status: new`, `group_role: take_profit`.
- **Leg:** one `stop` leg, `order_class: oco`, **`status: held`**, `group_role: stop_loss`, with the stop price and the full quantity.
- `status=open` returned the parent only. The held stop leg is read from the order history, the same as a filled bracket's. `AlpacaBrokerBooks` read the stop as protecting the long at 32.30.

This is the shape `broker-books.ts` assumed and the `broker-books.test.ts` OCO fixture draws, so neither changes beyond dropping the "unmeasured" notes.
