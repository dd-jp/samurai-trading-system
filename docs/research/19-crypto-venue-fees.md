# 19 — Crypto venue fees: the largest single term in the book's economics

**Produced:** 2026-08-09, resolving [#671](https://github.com/dd-jp/samurai-trading-system/issues/671) under map [#631](https://github.com/dd-jp/samurai-trading-system/issues/631).
**Feeds:** [ADR-0015](../adr/0015-live-venue-account-and-book-split.md) (may amend it), [ADR-0016](../adr/0016-universe-leveraged-etps-ungated.md) §Consequences.

[#658](https://github.com/dd-jp/samurai-trading-system/issues/658) ranked this the biggest lever available — worth ~5× everything catalyst-gating could touch. Half the book (£750) sits between "returns nothing" and "returns £590/yr" depending on numbers nobody had checked.

## The benchmark

The crypto leg's gross edge is **0.75%/trade** at the 4%/2% levels (#660). Every fee below is a round-trip cost subtracted from that.

## Finding 1 — the App and the Exchange are different products, and the App is unusable

This is the finding that matters most and was not in the ticket's scope.

**The Crypto.com App embeds its cost in a spread of roughly 0.5–1%** rather than charging a visible maker/taker fee. Against a 0.75% gross edge that is **negative-expectancy outright**, before any other cost.

**The Crypto.com Exchange is a separate platform with a separate signup**, and it is the one with the maker/taker schedule. Reported cost difference between the two is 3–5×.

David's stated *"i already have crypto.com account"* almost certainly refers to the App. **Having it confers nothing for this strategy.**

## Finding 2 — the fee schedules

| venue / tier | maker | taker | round trip (mixed) | net vs 0.75% edge |
| --- | --- | --- | --- | --- |
| **Crypto.com App** | spread-based | — | ~1.0–2.0% | **strongly negative** |
| Crypto.com Exchange, base (<$10K/30d, no CRO) | 0.25% | 0.50% | 0.75% | **£0 — exactly break-even** |
| Crypto.com Exchange, base, **taker-only** | — | 0.50% | 1.00% | **−0.25% — negative** |
| Coinbase Advanced, <$10K/30d | 0.40% | 0.60% | 1.00% | **−0.25% — negative** |
| Coinbase Advanced, $50–100K/30d | 0.25% | 0.40% | 0.65% | +0.10% |
| **Crypto.com Exchange + 5,000 CRO staked** | **0.0725%** | **0.0725%** | **0.145%** | **+0.605%** |

### Correction to #660

#660 assumed **Coinbase at 0.15/0.25**. The published schedule at the $50–100K band is **0.25/0.40**, and at the entry band **0.40/0.60**. Coinbase is materially worse than the split decision assumed, and at the entry band it is **negative-expectancy**.

### The volume assumption is inconsistent across tickets, and it matters for Coinbase only

#660 assumed ~$57K/month (60× capital, which implies roughly daily crypto trading). #658's arithmetic used 130 crypto trades/yr ≈ 10.8/month ≈ **$20.6K/month** — *below* Coinbase's $50K tier, which puts it in the 0.40/0.60 band and therefore negative.

**CRO staking makes the fee independent of volume.** That is its most valuable property here: it removes the leg's dependence on a trade-count assumption nobody has validated.

## Finding 3 — what the stake costs

| | |
| --- | --- |
| CRO price | **$0.0481 / £0.0357** |
| 5,000 CRO | **£178** |
| lock-up | **180 days**, cannot be withdrawn early |
| staking reward | ~8%/yr, ~£14/yr, paid daily in CRO |

**Payback: ~39 trades, roughly 3.6 months** at 130 trades/yr — inside the lock-up period.

**The stake is an unhedged CRO position.** £178 in a volatile asset locked for six months, held purely to buy a fee discount. A 50% CRO drawdown costs £89, against £590/yr of benefit — the trade survives comfortably, but it is a real position and should be recorded as one, not treated as a fee.

**Interaction with the £750 split.** If the stake is funded *out of* the crypto leg, tradeable capital falls to £572 and the leg returns ~£450/yr rather than £590. If funded on top, the book becomes £1,678. Either works; it should be a deliberate choice rather than a side effect.

## Finding 4 — `ccxt` support is not a constraint

`ccxt` supports Crypto.com via the `cryptocom` class, with every unified method the execution layer needs: `createOrder`, `fetchBalance`, `fetchOHLCV`, `fetchOrder`, `cancelOrder`, plus WebSocket `watchTicker` / `watchOrders`. Coinbase is likewise supported. **The venue choice is not constrained by the client library**, so it can be made purely on fees and access.

## Economics

Net per trade × £750, at 130 and 252 trades/yr:

| venue | £/trade | 130 trades/yr | 252 trades/yr |
| --- | --- | --- | --- |
| Crypto.com App | negative | **negative** | **negative** |
| Crypto.com Exchange, base | £0.00 | **£0** | **£0** |
| Coinbase, entry band (what 130 trades/yr actually reaches) | negative | **negative** | — |
| Coinbase, $50–100K band | £0.75 | £98 | £189 |
| **Crypto.com Exchange + 5,000 CRO** | **£4.54** | **£590** | **£1,144** |

## Verdict

**Crypto.com Exchange with 5,000 CRO staked.** It is the only configuration that makes the crypto leg meaningfully profitable, and it is the only one whose economics do not depend on hitting a volume tier.

**Coinbase is not the fallback #660 assumed.** At this book's realistic volume it lands in the entry band and is negative-expectancy. If the Exchange turns out to be unavailable, the honest options are to re-examine the venue question from scratch or to drop the crypto leg — not to switch to Coinbase and assume it works.

## Open — needs David's account, cannot be verified by research

1. **Can a UK resident open the Crypto.com *Exchange*?** The App and card are confirmed available (Foris DAX UK Ltd, FCA-registered under the MLRs as of June 2026). The Exchange is a separate platform carrying its own geo-restrictions, and UK eligibility could not be confirmed from public sources. **This is a hard precondition** — if the answer is no, the recommendation above is void.
2. **The 0.0725% figure needs confirming in-account.** Multiple secondary sources agree on it, but the primary fee page is JavaScript-rendered and could not be fetched. One source instead describes 5,000 CRO as buying "a 10% discount", which would give 0.225/0.45 — round trip 0.675%, net **+0.075%/trade**, i.e. ~£73/yr rather than £590. **The entire recommendation turns on which is right.**
3. **Maker/taker realism.** At 0.0725% both sides this stops mattering, which is a further argument for staking. At base fees it is decisive: taker-only puts the leg at −0.25%/trade.

Tracked as [#673](https://github.com/dd-jp/samurai-trading-system/issues/673).

## Regulatory note

UK spot crypto trading is permitted; the FCA ban covers derivatives for retail. A new authorisation regime opens for applications **30 September 2026**, with the full regime in force **25 October 2027** — not a near-term blocker, but the venue choice should not assume indefinite continuity.

## Sources

- [Crypto.com Fees Explained — GoBankingRates](https://www.gobankingrates.com/investing/crypto/crypto-com-fees/)
- [Crypto.com Review 2026 — Coinspeaker](https://www.coinspeaker.com/reviews/crypto-com-review/)
- [Crypto.com Review 2026 — Coincub](https://coincub.com/exchanges/crypto-com/)
- [Crypto Exchange Fees Compared 2026 — CoinLaw](https://coinlaw.io/crypto-exchange-fees/)
- [Coinbase Advanced Trade Fees vs Competitors — Bitget Academy](https://www.bitget.com/academy/coinbase-fee-compare)
- [Maker Taker Fees on Coinbase](https://makerfeesvstakerfees.org/maker-taker-fees-coinbase/)
- [ccxt — cryptocom exchange documentation](https://docs.ccxt.com/exchanges/cryptocom)
- [Crypto.com Soft Lockup — Help Center](https://help.crypto.com/en/articles/3744398-crypto-com-soft-lockup)
- [UK Crypto Regulations 2026 — Bitget Academy](https://www.bitget.com/academy/uk-crypto-regulation)
- [Crypto.com Supported & Restricted Countries — Datawallet](https://www.datawallet.com/crypto/crypto-com-countries)
