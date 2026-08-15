# 19 — Crypto venue fees: the largest single term in the book's economics

**Produced:** 2026-08-09, resolving [#671](https://github.com/dd-jp/samurai-trading-system/issues/671) under map [#631](https://github.com/dd-jp/samurai-trading-system/issues/631).
**Feeds:** [ADR-0015](../adr/0015-live-venue-account-and-book-split.md) (may amend it), [ADR-0016](../adr/0016-universe-leveraged-etps-ungated.md) §Consequences.

[#658](https://github.com/dd-jp/samurai-trading-system/issues/658) ranked this the biggest lever available — worth ~5× everything catalyst-gating could touch. Half the book (£750) sits between "returns nothing" and "returns £1,100–1,650/yr" depending on numbers nobody had checked.

## The benchmark

The crypto leg's gross edge is **0.75%/trade** at the 4%/2% levels (#660). Every fee below is a round-trip cost subtracted from that.

## Finding 1 — the App and the Exchange are different products, and the App is unusable

This is the finding that matters most and was not in the ticket's scope.

**The Crypto.com App embeds its cost in a spread of roughly 0.5–1%** rather than charging a visible maker/taker fee. Against a 0.75% gross edge that is **negative-expectancy outright**, before any other cost.

**The Crypto.com Exchange is a separate platform, a separate signup and — confirmed 2026-08-10 — a separate legal entity**: **Foris DAX Limited** (Cayman Islands), against the UK App business's **Foris DAX UK Limited**. It is the one with the maker/taker schedule. Reported cost difference between the two is 3–5×. See Finding 6 for what the entity split costs.

David's stated *"i already have crypto.com account"* almost certainly refers to the App. **Having it confers nothing for this strategy.**

## Finding 2 — the fee schedules

| venue / tier | maker | taker | round trip (mixed) | net vs 0.75% edge |
| --- | --- | --- | --- | --- |
| **Crypto.com App** | spread-based | — | ~1.0–2.0% | **strongly negative** |
| Crypto.com Exchange, base (<$10K/30d, no CRO) | 0.25% | 0.50% | 0.75% | **£0 — exactly break-even** |
| Crypto.com Exchange, base, **taker-only** | — | 0.50% | 1.00% | **−0.25% — negative** |
| Coinbase Advanced, <$10K/30d | 0.40% | 0.60% | 1.00% | **−0.25% — negative** |
| Coinbase Advanced, $10–50K/30d | 0.25% | 0.40% | 0.65% mixed / 0.50% maker-only | +0.10% / +0.25% |
| **Coinbase Advanced, $50–100K/30d** | **0.15%** | **0.25%** | 0.40% mixed / **0.30% maker-only** | +0.35% / **+0.45%** |
| **Crypto.com Exchange + 5,000 CRO staked** | **0.0725%** | **0.0725%** | **0.145%** | **+0.605%** |

### Volume: which Coinbase tier applies is decided by [#667](https://github.com/dd-jp/samurai-trading-system/issues/667), not by capital

**Corrected 2026-08-10.** This section previously asserted the book sits in tier 2 and never reaches tier 3, on a 130 trades/yr figure carried over from #658. **That figure contradicts the recorded product.** [ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md) commits to *"at least one equity and one crypto trade per day"*; [ADR-0016](../adr/0016-universe-leveraged-etps-ungated.md) caps trade count *"near one per day"*; [ADR-0017](../adr/0017-validation-gates-paper-operational-thesis-expectancy.md) sizes the paper gate at ~2 trades/day. **The crypto leg is ~1 trade/day — 130/yr is 0.36/day and was never a live assumption.**

At £750 a side, one round trip is £1,500 ≈ **$1,905** of Coinbase volume. So the tier is a pure function of the crypto **calendar**:

| crypto trades/yr | $/month | Coinbase tier |
| --- | --- | --- |
| 130 *(the withdrawn figure)* | $20.6K | tier 2 |
| **252 — crypto follows the equity session** | **$40.0K** | **tier 2**, near its top |
| **315 — the threshold** | **$50.0K** | tier 2 / tier 3 boundary |
| **365 — crypto trades every calendar day** | **$57.9K** | **tier 3** |

**#667 (crypto flat-by-close) therefore decides the fee tier.** It reads as a session-boundary question; it is also the crypto-trade-count question, and so half the crypto leg's economics.

**This reverses the correction previously filed against #660.** #660 assumed **0.15/0.25** — that is tier 3, and it is **right** on a 365-day crypto calendar. The earlier claim that #660 was wrong was itself wrong, and came from the 130/yr figure.

**The 365-day calendar clears the tier-3 threshold by only 16% — $57.9K against a $50K line — and the measure is a *trailing 30-day* one.** One quiet fortnight repricing the leg from 0.15/0.25 to 0.25/0.40 is entirely ordinary, and the direction is not controllable. On the Coinbase branch the crypto leg's cost is a function of realised trade count that nothing in the system guarantees.

**CRO staking removes that variable outright.** At a flat 0.0725% both sides the fee is volume-independent, so neither #667 nor a quiet month can move it. That is its most valuable property here — not the headline rate.

## Finding 3 — what the stake costs

| | |
| --- | --- |
| CRO price | **$0.0481 / £0.0357** |
| 5,000 CRO | **£178** |
| lock-up | **180 days**, cannot be withdrawn early |
| staking reward | ~8%/yr, ~£14/yr, paid daily in CRO |

**Payback: ~39 trades** — £178 against £4.54/trade saved versus the base Exchange tier. At ~1 crypto trade/day that is **6–8 weeks**, comfortably inside the 180-day lock-up.

**The stake is an unhedged CRO position.** £178 in a volatile asset locked for six months, held purely to buy a fee discount. A 50% CRO drawdown costs £89, against £1,100–1,650/yr of benefit — the trade survives comfortably, but it is a real position and should be recorded as one, not treated as a fee.

**Interaction with the £750 split.** If the stake is funded *out of* the crypto leg, tradeable capital falls to £572 and the leg returns ~£870–1,260/yr rather than £1,140–1,660. If funded on top, the book becomes £1,678. Either works; it should be a deliberate choice rather than a side effect.

## Finding 4 — Coinbase examined properly (David is willing to switch)

Re-examined 2026-08-09 after David said *"i am ok to use coinbase if tht can make things better"*.

**Corrected 2026-08-10** — this finding first asserted tier 2, on the withdrawn 130 trades/yr figure. At ~1 crypto trade/day the leg straddles the tier 2 / tier 3 boundary, and which side it lands on is [#667](https://github.com/dd-jp/samurai-trading-system/issues/667)'s to decide.

**Per-trade is the stable unit.** Annual figures embed a trade count that is not yet decided, so read this table first and the annual one second:

| Coinbase branch | round trip | **net/trade vs 0.75% edge** |
| --- | --- | --- |
| tier 2, taker-only | 0.80% | **−0.05% — negative** |
| tier 2, mixed | 0.65% | +0.10% |
| tier 2, maker-only | 0.50% | +0.25% |
| tier 3, taker-only | 0.50% | +0.25% |
| tier 3, mixed | 0.40% | +0.35% |
| **tier 3, maker-only** | 0.30% | **+0.45%** |
| *(Crypto.com + CRO, for comparison)* | *0.145%* | ***+0.605%*** |

**The tier and the execution style interact badly.** Tier 2 taker-only is the one negative cell — and tier 2 is exactly where a quiet fortnight puts you. So on the Coinbase branch the leg can flip to negative-expectancy through a combination of two things the strategy does not control: realised trade count and fill type.

**Coinbase One is not a lever.** Its zero trading fees **explicitly exclude Advanced Trade**, which is what the API uses. Preferred and Premium instead give **25% back on Advanced spot fees in USDC, capped at $100/month**:

| | tier 2 @ 252/yr | tier 3 @ 365/yr |
| --- | --- | --- |
| Advanced spot fees paid (mixed) | £1,229 | £1,095 |
| 25% rebate (cap not binding) | £307 | £274 |
| Preferred subscription ($29.99/mo) | −£283 | −£283 |
| **net** | **+£24/yr** | **−£9/yr** |

Immaterial either way, and perversely worth *more* at the worse tier, since it rebates fees rather than reducing them. **The relevant Coinbase number is plain Advanced Trade.**

### The two things that make this a real trade-off

**1. Coinbase makes maker-vs-taker load-bearing; staked Crypto.com does not.** Taker-only at tier 2 is negative-expectancy, so choosing Coinbase commits the strategy to resting limit orders — which fights an indicator-triggered entry that naturally crosses the spread. At a flat 0.0725% both sides, execution style stops mattering entirely. This is a hidden cost of switching and couples directly to [#654](https://github.com/dd-jp/samurai-trading-system/issues/654).

**2. Coinbase's UK position is materially stronger.** FCA **MiFID-equivalent investment-services licence granted July 2026**, on top of crypto registration from February 2025, with the Advanced Trade API explicitly serving spot. Crypto.com *Exchange* UK access is unverified and is #673's hard precondition.

### Verdict on the switch

**Conditional, and #673 settles it cheaply.**

- **Crypto.com Exchange available AND 5,000 CRO gives flat 0.0725%** → stay. **+0.605%/trade** beats Coinbase's best cell (+0.45%) by a third, and it removes both the maker-only constraint and the tier dependence.
- **Either condition fails** → **Coinbase with maker-only execution**. A certain +0.25–0.45%/trade beats an uncertain +0.605%.

Note the symmetry that makes this worth checking rather than guessing: if 5,000 CRO turns out to be merely "a 10% discount" (+0.075%/trade), **Coinbase wins outright at either tier**.

## Finding 5 — `ccxt` support is not a constraint

`ccxt` supports Crypto.com via the `cryptocom` class, with every unified method the execution layer needs: `createOrder`, `fetchBalance`, `fetchOHLCV`, `fetchOrder`, `cancelOrder`, plus WebSocket `watchTicker` / `watchOrders`. Coinbase is likewise supported. **The venue choice is not constrained by the client library**, so it can be made purely on fees and access.

## Economics

Net per trade × £750, at the two crypto calendars [#667](https://github.com/dd-jp/samurai-trading-system/issues/667) chooses between. The 130 trades/yr column is withdrawn — it sits below ADR-0014's recorded floor.

| venue | £/trade | 252/yr *(equity calendar → tier 2)* | 365/yr *(every day → tier 3)* |
| --- | --- | --- | --- |
| Crypto.com App | negative | **negative** | **negative** |
| Crypto.com Exchange, base | £0.00 | **£0** | **£0** |
| Coinbase, taker-only | −£0.38 / +£1.88 | **negative** | £684 |
| Coinbase, mixed | £0.75 / £2.63 | £189 | £958 |
| Coinbase, **maker-only** | £1.88 / £3.38 | £473 | **£1,232** |
| **Crypto.com Exchange + 5,000 CRO** | **£4.54** | **£1,144** | **£1,656** |

Coinbase's two columns are **different fee schedules**, not one schedule at two volumes — hence the two £/trade figures.

## Finding 6 — the Exchange is a **Cayman Islands** entity, and the FCA registration does not reach it

Added 2026-08-10, prompted by David: *"the exchange is developed by Foris DAX Limited… crypto.com app is developed by crypto.com"*. He is right, and the entity split is the substance of Finding 1, not a labelling quirk.

| | operator | UK regulatory status |
| --- | --- | --- |
| Crypto.com **App** (UK) | **Foris DAX UK Limited** | **FCA-registered** for cryptoasset activities under the MLRs 2017, **FRN 941745** |
| Crypto.com **Exchange** | **Foris DAX Limited** — *"an exempted company incorporated in the Cayman Islands with limited liability"* | **none** — not the FCA-registered entity |

The Exchange Terms and Conditions (last updated 22 December 2025) are **"Published by Foris DAX Limited"** and define **"Crypto.com means Foris DAX Limited."** They are a different contract with a different counterparty from the App's.

**Eligibility is defined positively, then negatively.** Clause 14.1 requires that you are *"(a) a resident of an Available Jurisdiction; (b) not located in, under the jurisdiction of, or a national or resident of any of the countries, states, and jurisdictions listed here"*, and clause 18.2(a) repeats it as a warranty. **"Available Jurisdiction means a jurisdiction which is stated here, where the Exchange is available for service"** — and that positive list is behind a link that resolves to no public page.

**The negative list is public, and the UK is not on it.** The Exchange's spot-trading geo-restrictions article names **41 restricted locations** — Afghanistan, Bangladesh, Bolivia, Burundi, Central African Republic, DR Congo, Cuba, Ecuador, Eritrea, Guinea, Guinea-Bissau, **Hong Kong**, Iran, Iraq, Kyrgyzstan, Lebanon, Libya, Mali, **Malta**, Myanmar, Namibia, Nepal, North Korea, Palau, **China**, **Russia**, Somalia, South Sudan, Sudan, Syria, occupied regions of Ukraine, Venezuela, Yemen, Zimbabwe. **The United Kingdom does not appear.**

### What this changes

**UK access is now probable rather than unknown**, which upgrades question 1 from a hard unknown to a signup formality. It cannot be called *confirmed* — absence from a restriction list is not presence on an availability list, and only the live signup settles it.

**But a new cost appears on the Crypto.com side, and it is not a fee.** Trading the Exchange as a UK resident means contracting with a **Cayman company that holds no UK registration**: no FCA cryptoasset registration covering that entity, no FSCS, and UK recourse running through a foreign counterparty. The App's FRN 941745 provides none of this protection, because the App is a different company.

**This sharpens the venue comparison rather than settling it.** The choice is now explicitly:

| | Crypto.com Exchange (staked) | Coinbase Advanced |
| --- | --- | --- |
| expectancy | **+0.605%/trade** | +0.25% to +0.45%/trade |
| depends on volume tier / fill type | **no** | **yes, both** |
| UK counterparty | **Cayman, unregistered in the UK** | **FCA MiFID-equivalent licence (July 2026) + crypto registration (Feb 2025)** |
| capital at risk beyond the book | **£178 in CRO, locked 180 days** | none |

At £750 the counterparty exposure is bounded by the leg itself, so this is a judgement about tail risk on a small book, not a disqualifier. **It should be David's call, made explicitly.** Recorded on [#673](https://github.com/dd-jp/samurai-trading-system/issues/673).

## Verdict

**Crypto.com Exchange with 5,000 CRO staked, if #673 confirms it.** At +0.605%/trade it is the configuration that makes the crypto leg meaningfully profitable, and the only one whose economics depend on **neither** a volume tier **nor** execution style. Both of those are uncontrolled variables on every other branch.

**Coinbase is a real fallback, but a conditional one.** It ranges from **negative-expectancy** (tier 2, taker-only) to +0.45%/trade (tier 3, maker-only) — a spread driven by realised trade count and fill type rather than by anything the strategy decides. Choosing it makes resting limit orders a hard requirement, not a preference. Against that, its UK position is materially stronger (FCA MiFID-equivalent licence, July 2026), which is precisely the risk #673 carries for Crypto.com.

**Decision rule:** if #673 confirms UK access **and** the flat 0.0725%, stay with Crypto.com. If either fails — including the "10% discount" reading, which drops the leg to +0.075%/trade — **switch to Coinbase with maker-only execution**. A certain +0.25–0.45%/trade beats an uncertain +0.605%.

## Open — needs David's account, cannot be verified by research

1. **Can a UK resident open the Crypto.com *Exchange*?** **Largely answered 2026-08-10 — see Finding 6. Probable, but on a Cayman entity outside FCA registration.** What remains is a live signup attempt, since the positive "Available Jurisdiction" list is not public.
2. **The 0.0725% figure needs confirming in-account.** Multiple secondary sources agree on it, but the primary fee page is JavaScript-rendered and could not be fetched. One source instead describes 5,000 CRO as buying "a 10% discount", which would give 0.225/0.45 — round trip 0.675%, net **+0.075%/trade** — ~£140–205/yr rather than £1,140–1,660, and **worse than every Coinbase branch except tier 2 taker-only**. **The entire recommendation turns on which is right.**
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
- [Exchange Terms and Conditions, published by Foris DAX Limited, 22 Dec 2025 (PDF)](https://static2.crypto.com/exchange/assets/documents/tnc.pdf) — clauses 14.1, 18.2; definitions of *Available Jurisdiction* and *Crypto.com*
- [Spot trading geo-restrictions — Crypto.com Help Center](https://help.crypto.com/en/articles/6320975-spot-trading-geo-restrictions) — the 41 restricted locations; the UK is absent
- [Foris DAX Limited Privacy Notice (Exchange)](https://static2.crypto.com/exchange/assets/documents/privacy.pdf) — Cayman Islands incorporation
- [FORIS DAX UK LIMITED — FCA Register](https://register.fca.org.uk/s/firm?id=0014G00002antHVQAY) — FRN 941745, cryptoasset registration under the MLRs 2017
- [FORIS DAX UK LIMITED — Companies House](https://find-and-update.company-information.service.gov.uk/company/12843841)
