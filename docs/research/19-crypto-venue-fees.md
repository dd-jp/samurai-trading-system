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
| **Coinbase Advanced, $10–50K/30d — the band this book is in** | **0.25%** | **0.40%** | 0.65% mixed / **0.50% maker-only** | +0.10% / **+0.25%** |
| **Crypto.com Exchange + 5,000 CRO staked** | **0.0725%** | **0.0725%** | **0.145%** | **+0.605%** |

### Correction to #660

#660 assumed **Coinbase at 0.15/0.25**. The published schedule is **0.25/0.40 at $10–50K** and **0.40/0.60 below $10K**. Coinbase is worse than the split decision assumed, though not fatally so — see Finding 4.

### The volume assumption is inconsistent across tickets, and it matters for Coinbase only

#660 assumed ~$57K/month (60× capital, which implies roughly daily crypto trading). #658's arithmetic used 130 crypto trades/yr ≈ 10.8/month ≈ **$20.6K/month**. Both land in Coinbase's **$10–50K tier 2**, so the tier is stable across the disagreement — but neither reaches tier 3, so the $50–100K rates quoted in some comparisons never apply to this book.

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

## Finding 4 — Coinbase examined properly (David is willing to switch)

Re-examined 2026-08-09 after David said *"i am ok to use coinbase if tht can make things better"*.

**The band this book actually lands in is tier 2, $10K–50K/month: 0.25% maker / 0.40% taker.** At £750 × 2 per round trip, volume is ~$20.6K/month at 130 trades/yr and ~$40K at 252 — tier 3 is never reached, so the earlier $50–100K row is not the relevant one.

**Coinbase One is not a lever.** Its zero trading fees **explicitly exclude Advanced Trade**, which is what the API uses. Preferred and Premium instead give **25% back on Advanced spot fees in USDC, capped at $100/month**:

| | 130 trades/yr | 252 trades/yr |
| --- | --- | --- |
| Advanced spot fees paid | £634 | £1,229 |
| 25% rebate (cap not binding) | £158 | £307 |
| Preferred subscription ($29.99/mo) | −£283 | −£283 |
| **net** | **−£125/yr** | **+£24/yr** |

Net-negative at the realistic trade count and marginal at best above it. The relevant Coinbase number is therefore plain Advanced Trade.

| Coinbase execution style | round trip | net vs 0.75% edge | 130 trades/yr | 252/yr |
| --- | --- | --- | --- | --- |
| taker-only | 0.80% | **−0.05%** | **negative** | **negative** |
| mixed 50/50 | 0.65% | +0.10% | £98 | £189 |
| maker-only | 0.50% | +0.25% | **£244** | **£473** |

### The two things that make this a real trade-off

**1. Coinbase makes maker-vs-taker load-bearing; staked Crypto.com does not.** Taker-only on Coinbase is negative-expectancy, so choosing it commits the strategy to resting limit orders — which fights an indicator-triggered entry that naturally crosses the spread. At a flat 0.0725% both sides, execution style stops mattering entirely. This is a hidden cost of switching and couples directly to [#654](https://github.com/dd-jp/samurai-trading-system/issues/654).

**2. Coinbase's UK position is materially stronger.** FCA **MiFID-equivalent investment-services licence granted July 2026**, on top of crypto registration from February 2025, with the Advanced Trade API explicitly serving spot. Crypto.com *Exchange* UK access is unverified and is #673's hard precondition.

### Verdict on the switch

**Conditional, and #673 settles it cheaply.**

- **Crypto.com Exchange available AND 5,000 CRO gives flat 0.0725%** → stay. £590/yr against £244/yr is not close, and it removes the maker-only constraint.
- **Either condition fails** → **Coinbase with maker-only execution**, ~£244/yr. A certain £244 beats an uncertain £590.

Note the symmetry that makes this worth checking rather than guessing: if 5,000 CRO turns out to be merely "a 10% discount" (£73/yr), **Coinbase wins outright**.

## Finding 5 — `ccxt` support is not a constraint

`ccxt` supports Crypto.com via the `cryptocom` class, with every unified method the execution layer needs: `createOrder`, `fetchBalance`, `fetchOHLCV`, `fetchOrder`, `cancelOrder`, plus WebSocket `watchTicker` / `watchOrders`. Coinbase is likewise supported. **The venue choice is not constrained by the client library**, so it can be made purely on fees and access.

## Economics

Net per trade × £750, at 130 and 252 trades/yr:

| venue | £/trade | 130 trades/yr | 252 trades/yr |
| --- | --- | --- | --- |
| Crypto.com App | negative | **negative** | **negative** |
| Crypto.com Exchange, base | £0.00 | **£0** | **£0** |
| Coinbase Advanced tier 2, taker-only | negative | **negative** | **negative** |
| Coinbase Advanced tier 2, mixed | £0.75 | £98 | £189 |
| Coinbase Advanced tier 2, **maker-only** | £1.88 | **£244** | **£473** |
| **Crypto.com Exchange + 5,000 CRO** | **£4.54** | **£590** | **£1,144** |

## Verdict

**Crypto.com Exchange with 5,000 CRO staked, if #673 confirms it.** It is the configuration that makes the crypto leg meaningfully profitable, and the only one whose economics depend neither on a volume tier nor on execution style.

**Coinbase is a real fallback, but a worse one, and not free of conditions.** At tier 2 it returns ~£244/yr maker-only and ~£98/yr mixed — but **taker-only it is negative-expectancy**, so choosing it makes resting limit orders a hard requirement rather than a preference. Against that, its UK position is materially stronger (FCA MiFID-equivalent licence, July 2026), which is precisely the risk #673 carries for Crypto.com.

**Decision rule:** if #673 confirms UK access **and** the flat 0.0725%, stay with Crypto.com. If either fails — including the "10% discount" reading, which drops the leg to £73/yr — **switch to Coinbase with maker-only execution**. A certain £244/yr beats an uncertain £590/yr.

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
