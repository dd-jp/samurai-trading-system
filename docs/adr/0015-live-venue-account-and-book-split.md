# ADR-0015 — Live venue, account type and the £1,500 book split

- **Status:** Accepted
- **Date:** 2026-08-09
- **Decided by:** David — *"will run paper for 14 days and then decide whether live. will start with 1500£"*, *"i already have crypto.com account. you decide how 1500 is split based on maths"*
- **Related:** [#659](https://github.com/dd-jp/samurai-trading-system/issues/659) (broker reality check), [#660](https://github.com/dd-jp/samurai-trading-system/issues/660) (book split), [#671](https://github.com/dd-jp/samurai-trading-system/issues/671) (the fee-tier verification that can overturn the split), map [#631](https://github.com/dd-jp/samurai-trading-system/issues/631)
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

## Consequences

**The default universe is not tradeable on the live path.** SPY / QQQ / AAPL / TSLA / BTC-USD / ETH-USD is an *Alpaca* universe. It remains correct for paper and backtest data and must not be assumed for live instruments, spreads or fees. Instrument selection is [ADR-0016](0016-universe-leveraged-etps-ungated.md).

**No `Trading212Adapter` exists.** The execution layer is entirely Alpaca. T212's public API (`live.trading212.com/api/v0`, ~50 req/min) is in beta, and its suitability is unverified — [#665](https://github.com/dd-jp/samurai-trading-system/issues/665) and [#666](https://github.com/dd-jp/samurai-trading-system/issues/666).

**Crypto cannot be ramped gradually.** Below the fee tier the leg's expectancy is at or under zero, so a partial deployment is a *different and worse* strategy, not a smaller version of the same one. The live ramp therefore runs on the **equity leg alone**; crypto stays in paper until the full £750 deploys at once.

**PDT never binds.** FINRA Rule 4210 governs US margin accounts. A UK cash ISA is neither. Verified on the paper path too — the Alpaca paper account carries $100,000 equity against the $25,000 threshold ([#657](https://github.com/dd-jp/samurai-trading-system/issues/657)).

**UK tax.** CGT is immaterial at £1,500 against a £3,000 annual exempt amount, but every crypto disposal and equity trade is still a recordable event, and HMRC badges-of-trade reclassification to income remains a theoretical exposure at high trade counts.

## Known weakness

**The crypto fee assumption is unverified and it is the largest single term in the book's economics.** At Crypto.com's base tier (0.25% maker / 0.50% taker) the crypto leg returns **£0/yr** — a 0.75% mixed round trip against a 0.75% gross edge. At a reported 0.0725%/side via CRO staking it returns roughly **£590/yr**.

Half the book therefore sits between "worthless" and "the best line in the plan" depending on a number nobody has checked. [#671](https://github.com/dd-jp/samurai-trading-system/issues/671) owns it and **may overturn this ADR's split**, including a venue switch to Coinbase Advanced — #660's instruction was explicit that an account already held is not worth a worse fee schedule.
