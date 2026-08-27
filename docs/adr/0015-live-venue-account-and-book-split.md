# ADR-0015 — Live venue, account type and the £1,500 book split

- **Status:** Accepted
- **Date:** 2026-08-09
- **Decided by:** David — *"will run paper for 14 days and then decide whether live. will start with 1500£"*, *"i already have crypto.com account. you decide how 1500 is split based on maths"*
- **Related:** [#659](https://github.com/dd-jp/samurai-trading-system/issues/659) (broker reality check), [#660](https://github.com/dd-jp/samurai-trading-system/issues/660) (book split), [#671](https://github.com/dd-jp/samurai-trading-system/issues/671) (crypto fee schedules — **resolved**, see the 2026-08-10 amendment), [#673](https://github.com/dd-jp/samurai-trading-system/issues/673) (the two account facts that pick the venue), [#667](https://github.com/dd-jp/samurai-trading-system/issues/667) (the crypto calendar, which sets the fee tier), map [#631](https://github.com/dd-jp/samurai-trading-system/issues/631)
- **Does not supersede** [ADR-0001](0001-technical-foundation-hybrid.md) — Alpaca remains the paper and backtest data path. This ADR decides the **live** venue only.

## Context

ADR-0001 routed the MVP through Alpaca paper with a `BrokerAdapter` abstraction and a dual-target long-term plan (ccxt for crypto, IBKR for stocks). It did not decide what a UK retail account with £1,500 can actually trade, and the intraday horizon of [ADR-0014](0014-intraday-flat-by-close-horizon.md) makes per-trade cost the dominant term rather than a rounding error.

## Decision

### Equity leg — Trading 212 **Stocks & Shares ISA**, restricted to **GBP LSE-listed ETFs and ETCs**

The restriction is not a preference; it is what survives the cost arithmetic at this size:

| Instrument class | Round-trip cost | Verdict |
| --- | --- | --- |
| US stocks on T212 | **0.30%** FX fee | Negative-expectancy against a ~0.2%/trade edge |
| UK individual shares | **0.5%** stamp duty (SDRT) | Dead on arrival |
| **GBP LSE-listed ETFs / ETCs** | No SDRT, no FX | **The only viable class** |

That one class also covers gold, oil and bonds via ETCs, so the universe loses less than it appears to.

**Brokers rejected:** Freetrade — no API at all. IBKR — a £3/trade floor is **0.6% round trip** at this size, worse than the edge.

### Crypto leg — a separate `ccxt` exchange account

**Crypto cannot go in the ISA.** Since 6 April 2026 crypto ETNs are IFISA-only, and direct crypto was never eligible for a Stocks & Shares ISA. The two legs therefore sit in different accounts by regulation, not by design.

### The book — **£1,500, split £750 equity / £750 crypto**

Driven by a **fee-tier cliff**, not by risk balance. Crypto's two-way monthly volume at this cadence is roughly 60× capital, so the capital level decides which fee tier applies, and crossing ~$50K/month multiplies that leg's return by ~3.5×. The cliff sits at **~£656**.

- £750 clears it with a 14% buffer.
- £656 sits exactly on it — no margin for a quiet month.
- **£1,000/£500 is the worst split available**: it takes crypto's volatility without the fee tier that pays for it.

**Minimum viable book: ~£1,400.** £1,500 clears it.

> **The cliff's premise, made explicit (2026-08-10, [#671](https://github.com/dd-jp/samurai-trading-system/issues/671)).** "60× capital" is **365 crypto trades/yr** — one per *calendar* day. At £750 a side a round trip is £1,500 ≈ $1,905, so 365/yr is $57.9K/month and clears the $50K tier boundary; **252/yr — crypto following the equity session — is $40.0K/month and does not.** On a 252-day crypto calendar the cliff moves to **~£937** and £750 misses it. The premise holds or fails on [#667](https://github.com/dd-jp/samurai-trading-system/issues/667), which is therefore a fee decision as well as a session-boundary one. The cliff is arithmetically sound; it is conditional, not unconditional.

## Consequences

**The default universe is not tradeable on the live path.** SPY / QQQ / AAPL / TSLA / BTC-USD / ETH-USD is an *Alpaca* universe. It remains correct for paper and backtest data and must not be assumed for live instruments, spreads or fees. Instrument selection is [ADR-0016](0016-universe-leveraged-etps-ungated.md).

**No `Trading212Adapter` exists.** The execution layer is entirely Alpaca. T212's public API (`live.trading212.com/api/v0`, ~50 req/min) is in beta, and its suitability is unverified — [#665](https://github.com/dd-jp/samurai-trading-system/issues/665) and [#666](https://github.com/dd-jp/samurai-trading-system/issues/666).

**Crypto cannot be ramped gradually.** Below the fee tier the leg's expectancy is at or under zero, so a partial deployment is a *different and worse* strategy, not a smaller version of the same one. The live ramp therefore runs on the **equity leg alone**; crypto stays in paper until the full £750 deploys at once.

**PDT never binds.** FINRA Rule 4210 governs US margin accounts. A UK cash ISA is neither. Verified on the paper path too — the Alpaca paper account carries $100,000 equity against the $25,000 threshold ([#657](https://github.com/dd-jp/samurai-trading-system/issues/657)).

**UK tax (as this ADR currently names the venue).** While the equity leg trades inside a Trading 212 Stocks & Shares ISA, HMRC treats it as unconditionally exempt from Capital Gains Tax — gains and losses inside the wrapper are outside CGT's scope regardless of trade size, count, or gains realised ([gov.uk — Capital Gains Tax: What you pay it on](https://www.gov.uk/capital-gains-tax/what-you-pay-it-on): "You do not pay Capital Gains Tax on certain assets, including any gains you make from: ISAs or PEPs"). That is a wrapper exemption, not a magnitude one — while the leg sits inside the ISA, the £3,000 annual exempt amount does not bind it. **This is not durable.** Map [#905](https://github.com/dd-jp/samurai-trading-system/issues/905) records David's 2026-08-25/26 ruling that the live leg goes GIA-only; [`docs/research/38-gia-relaxed-venue-rescore.md`](../research/38-gia-relaxed-venue-rescore.md) works out the consequence — a GIA carries no CGT wrapper, so every equity disposal becomes a recordable, reportable event once the venue moves (the doc's own arithmetic: roughly £87,500/yr in disposal proceeds from the index leg alone clears HMRC's £12,000 mandatory Self Assessment disclosure threshold). [#896](https://github.com/dd-jp/samurai-trading-system/issues/896) keeps Trading 212 itself blocked regardless of wrapper, so this ADR still names the ISA below pending that ticket's resolution — treat this note as the operative truth once it closes, not the paragraph above. Crypto has no such shelter under either wrapper: every crypto disposal — and, once the leg moves to a GIA, every equity trade too — is a recordable event, and HMRC badges-of-trade reclassification to income remains a theoretical exposure at high trade counts.

## Amendment, 2026-08-10 — the crypto fee schedule, measured ([#671](https://github.com/dd-jp/samurai-trading-system/issues/671))

This section previously read *"the crypto fee assumption is unverified… a number nobody has checked."* It has now been checked. Full working in [`docs/research/19-crypto-venue-fees.md`](../research/19-crypto-venue-fees.md); the load-bearing results:

**1. The Crypto.com App and the Crypto.com Exchange are different products, and the App is unusable.** The App embeds its cost in a ~0.5–1% spread — **negative-expectancy against a 0.75% gross edge**, before anything else. David's existing Crypto.com account is almost certainly the App and **confers nothing**; the Exchange is a separate signup. This ADR means the **Exchange** wherever it says Crypto.com.

**2. The schedules, as net expectancy per trade against the 0.75% gross edge.** Per-trade is the stable unit — annual figures embed a trade count [#667](https://github.com/dd-jp/samurai-trading-system/issues/667) has not yet decided:

| branch | round trip | net/trade |
| --- | --- | --- |
| Crypto.com App | ~1.0–2.0% | **strongly negative** |
| Crypto.com Exchange, base tier | 0.75% | **£0 — exactly break-even** |
| Coinbase tier 2 ($10–50K), taker-only | 0.80% | **−0.05% — negative** |
| Coinbase tier 2, maker-only | 0.50% | +0.25% |
| Coinbase tier 3 ($50–100K), maker-only | 0.30% | +0.45% |
| **Crypto.com Exchange + 5,000 CRO staked** | **0.145%** | **+0.605%** |

**3. This ADR's split survives; its stated reason is conditional.** See the note under *The book* above — the £656 cliff assumes 365 crypto trades/yr. It is #667's to confirm.

**4. CRO staking is the only branch whose cost is not an uncontrolled variable.** At a flat 0.0725% both sides, the fee depends on neither volume tier nor maker/taker fill. Every Coinbase branch depends on both, and Coinbase's tier is set by *trailing 30-day* volume — a quiet fortnight reprices the leg downward mid-month, in the direction the strategy does not choose. The stake costs **£178**, locks **180 days**, pays back in **~39 trades (6–8 weeks)**, and is an **unhedged CRO position** that should be booked as one, not as a fee.

**5. `ccxt` supports both venues.** The choice is not constrained by the client library.

### Still open — [#673](https://github.com/dd-jp/samurai-trading-system/issues/673) settles the venue

Two facts could not be established from public sources and need David's account: **whether a UK resident can open the Crypto.com *Exchange*** (the App and card are confirmed; the Exchange carries separate geo-restrictions), and **whether 5,000 CRO gives a flat 0.0725% or merely "a 10% discount"** (the latter is +0.075%/trade — worse than every Coinbase branch but tier 2 taker-only).

**Decision rule, recorded so an implementation agent does not have to re-derive it:**

- **Both confirmed** → Crypto.com Exchange with 5,000 CRO staked. Best expectancy, and execution style stops mattering.
- **Either fails** → **Coinbase Advanced, maker-only execution mandatory.** Taker-only at tier 2 is negative-expectancy, so this is a hard constraint on the execution layer, not a preference — it couples directly to the exit ladder ([#654](https://github.com/dd-jp/samurai-trading-system/issues/654)).

Coinbase's UK regulatory position is materially the stronger of the two (FCA MiFID-equivalent investment-services licence, July 2026, on top of crypto registration from February 2025), which is precisely the risk #673 carries for Crypto.com.

**Unchanged by this amendment:** the £750/£750 split, the ISA restriction, and the equity leg. **#660's Coinbase assumption of 0.15/0.25 was correct** at tier 3 — an earlier correction filed against it has been withdrawn.

## Amendment — 2026-08-16: crypto leaves Samurai's scope, and the split with it

- **Earned by:** [#705](https://github.com/dd-jp/samurai-trading-system/issues/705), resolved 2026-08-16 under map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703)
- **Decided by:** David — *"actually drop crypto. we'll create a new system one later for handling crypto trades."*
- **Companion amendments:** [ADR-0014](0014-intraday-flat-by-close-horizon.md) (the scope ruling and the full price), [ADR-0017](0017-validation-gates-paper-operational-thesis-expectancy.md) (both gates equities-only), [ADR-0018](0018-intraday-thresholds-sizing-and-the-signal-bar.md) (selection budget drops to two)

**Samurai is an equities system. The £750/£750 split no longer describes its book.**

### What this amendment does NOT undo

**The reasoning that produced the split is untouched and remains correct.** Crypto is barred from a S&S ISA, so a crypto leg genuinely required a separate `ccxt` exchange account — that is a fact about UK tax wrappers, not a preference, and it will bind the future crypto system exactly as it bound this one. Likewise the venue analysis: the Crypto.com-versus-Coinbase comparison, the CRO staking arithmetic, the maker-only constraint at Coinbase tier 2, and the £656 cliff's dependence on 365 crypto trades/yr are all **preserved as inputs the future crypto system inherits**, not withdrawn as errors.

What changes is only *whose* decisions they are. [#671](https://github.com/dd-jp/samurai-trading-system/issues/671) and [#673](https://github.com/dd-jp/samurai-trading-system/issues/673) should be re-labelled as belonging to that future system rather than left reading as pending Samurai work — they are decided or near-decided, and re-deriving them later would be waste.

### The capital question this opens, and deliberately does not close

With no crypto leg, the £750 crypto allocation has no consumer. **Whether Samurai's equity leg now takes the full £1,500 is not decided here**, and it must not be settled by inference, because it is not a bookkeeping change:

[ADR-0018](0018-intraday-thresholds-sizing-and-the-signal-bar.md) D5 sizes positions as a fixed fraction *of the equity leg* — ~35% (~£260) for 3x index ETPs and ~25% (~£190) for 3x single-stock ETPs, chosen to hold measured max drawdown at 23.1% and 26.2% against `CONTEXT.md`'s ~20-25% tolerance. **Those fractions are calibrated to a £750 leg.** Doubling the leg to £1,500 doubles the cash at risk per position while the *percentage* drawdown envelope stays put — so the tolerance still holds in percentage terms, but the absolute loss at the envelope doubles, and the single-stock subclass is already recorded as overshooting the band by ~1.2 pp.

It also interacts with [ADR-0017](0017-validation-gates-paper-operational-thesis-expectancy.md)'s live ramp, which starts at **£100-200** deliberately — "tuition money" sized to surface the three unconfirmables at the smallest size producing real fills. A larger total book does not change what that ramp is for.

**So the open question is:** does the equity leg become £1,500, stay at £750 with £750 held back for the future crypto system, or something else? It needs its own record before the live ramp, and it should be decided against the drawdown envelope rather than against the fact that the money is idle.

> **ANSWERED 2026-08-18 — see the amendment below.** It is "something else": the book is re-based to **£1,000, all equity**. This section is left as written because the *question* it frames is what the next amendment answers; read the two together and do not quote the £750/£1,500 options as live.

**Unchanged by this amendment:** the ISA restriction, the GBP LSE-listed ETF/ETC constraint on the equity leg, and the equity venue itself (Trading 212 ISA).

## Amendment — 2026-08-18: the book is **£1,000, all equity**

- **Earned by:** [#800](https://github.com/dd-jp/samurai-trading-system/issues/800) (AC4) and [#798](https://github.com/dd-jp/samurai-trading-system/issues/798), which both terminated on this one ruling
- **Decided by:** David — *"we are cancelling crypto so equity book takes 1000£"*
- **Answers:** the question the 2026-08-16 amendment opened and deliberately left open

**The 2026-08-16 amendment asked whether the equity leg becomes £1,500, stays at £750, or "something else". It is something else: the total book is re-based from £1,500 to £1,000, and all of it is equity.** **This ruling does not allocate the £500 difference** — where it goes, whether to the future crypto system or nowhere, is not decided here and should not be inferred from the arithmetic closing.

### What follows mechanically

**There is no longer a leg to be a fraction of.** ADR-0018 D5's "fraction of the equity leg" and "fraction of the account" are now the same quantity, so the `EQUITY_LEG_FRACTION_OF_CAPITAL = 0.5` that encoded the split is **deleted**, not set to `1.0`, and D5's fractions reach `RiskPortfolioView.equity` unscaled (`paper-profile.ts`). `LIVE_BOOK_GBP = 1_000` records the inception figure; the gate still resolves against live equity per D5's sizing amendment (#739). That constant is **documentation and enforces nothing** — no runtime path reads it, so it is not a bound on the book.

**The precondition the deletion rests on, stated because it is a live-money sizing path.** The `0.5` was an *account → leg* conversion: `RiskPortfolioView.equity` is the whole account while D5's fractions are of the leg. Removing it is correct **exactly while the funded equity read equals the book.** If the Trading 212 ISA is ever funded above £1,000, `0.35 × equity` sizes against the account rather than the book — £525 on a £1,500 account, not £350 — and the correct repair is then a `book / equity` conversion resolved live, **not** a re-introduced constant. Fund the account to the book, or wire the conversion.

**Cash at risk per position roughly doubles**, and the ~£260/~£190 figures D5 published are historical — they were calibrated on the £750 leg. On the £1,000 book the same fractions resolve to **£350 (index) and £250 (single-stock)**, against **£175 / £125** under the split. The percentage envelope is what D5 bounds and it is unchanged; the absolute loss at the envelope is what moves.

**This makes [#798](https://github.com/dd-jp/samurai-trading-system/issues/798) live rather than dissolving it, and that is the load-bearing consequence.** The single-stock subclass now deploys `f = 0.25` **unscaled** — exactly the fraction D5 published and measured — and D5's #729 verification note measures the drawdown at that fraction and the declared brackets at **~41.8%**, roughly 17 pp above `CONTEXT.md`'s 20–25% tolerance. Under the 0.5 scaler the effective `f = 0.125` sat below the `f ≈ 0.142` the tolerance needs, and #798 would largely have dissolved; at £750-funded it would have dissolved outright. **The ruling picks the branch on which the overshoot is real**, so #798 is now a required decision before the live ramp, not a contingent one. Nothing mis-sizes today only because `lse-etp-pool.ts` is deliberately unwired ([#751](https://github.com/dd-jp/samurai-trading-system/issues/751) is the deadline).

**No re-run of the envelope generator is needed to say that.** `f = 0.25` and the ~41.8% figure are ADR-0018's own published, measured pair; it was the *scaled* `f = 0.125` that would have required a fresh run of `18-drawdown-envelope.py`, and that branch is now moot.

### What this does not change

The **ISA restriction**, the **GBP LSE-listed ETF/ETC constraint**, the **Trading 212 venue**, and **[ADR-0017](0017-validation-gates-paper-operational-thesis-expectancy.md)'s £100–200 live ramp** — the ramp is sized to surface the three unconfirmables at the smallest size producing real fills, and a smaller total book does not change what it is for. The **UK tax position** is unchanged by this book-size amendment, and was never a matter of size: while the book is ISA-wrapped, gains and losses inside a Trading 212 Stocks & Shares ISA sit outside CGT's scope unconditionally, independent of book size — the £3,000 exempt amount does not bind this leg at £1,500 or at £1,000, for as long as it stays ISA-wrapped. See the UK tax note above: that wrapper-dependence is not durable — map #905 / doc 38 record a pending GIA-only ruling for the live leg that would remove it.

`docs/research/54-capital-economics-vs-signal-accuracy.md` states its arithmetic **per £1,000 notional**, which is now the book rather than a convenient unit — its 0.55 pp cost-in-accuracy figure applies directly, and the £5,000 column there is hypothetical.
