# 42 — Tax-loss harvesting mechanics: an input for a future non-ISA account or crypto system

**Produced:** 2026-08-26.
**Status:** NOT APPLICABLE TO SAMURAI'S CURRENT LIVE SYSTEM (still ISA-wrapped as booted). **Not durable — read before treating "future GIA leg" below as remote.** Map [#905](https://github.com/dd-jp/samurai-trading-system/issues/905) records David's 2026-08-25/26 ruling that the live equity leg goes **GIA-only**, not ISA; [#896](https://github.com/dd-jp/samurai-trading-system/issues/896) (the venue-blocker that gated treating this as operative) closed 2026-08-27. The venue itself is still open ([#910](https://github.com/dd-jp/samurai-trading-system/issues/910) Saxo, [#911](https://github.com/dd-jp/samurai-trading-system/issues/911) IBKR, both OPEN), but the wrapper choice is already settled: whichever venue #905 lands on, it is GIA. This doc's "future non-ISA/GIA equity leg" consumer (below) is therefore Samurai's own live leg on its ruled trajectory, not a hypothetical successor system — preserved as an input for that transition and for the future standalone crypto system, the same posture [`19-crypto-venue-fees.md`](19-crypto-venue-fees.md) takes for crypto venue research after crypto left scope.

## Why this doc exists, and why it doesn't bind anything today

Samurai's equity leg **currently boots inside** a Trading 212 Stocks & Shares ISA. Gains and losses realised inside an ISA wrapper are **outside the scope of UK Capital Gains Tax entirely** — this is not a case of the gains being small relative to an allowance, it is the wrapper removing CGT from the picture unconditionally. Two gov.uk pages confirm this directly: [gov.uk — Capital Gains Tax: What you pay it on](https://www.gov.uk/capital-gains-tax/what-you-pay-it-on) states "You do not pay Capital Gains Tax on certain assets, including any gains you make from: ISAs or PEPs"; [gov.uk — Individual Savings Accounts (ISAs): How ISAs work](https://www.gov.uk/individual-savings-accounts/how-isas-work) states "You do not pay tax on: interest on cash in an ISA, income or capital gains from investments in an ISA." Tax-loss harvesting is a technique for managing a CGT bill; there is no CGT bill to manage while every disposal happens inside the wrapper. **This doc is not a feature spec for Samurai as it stands** — but per the Status line above, "as it stands" is the ISA-booted state specifically, not a durable description; see ADR-0015's live UK-tax note for the operative-once-#905-lands framing.

Crypto is the only leg of Samurai that would actually generate CGT events under the *current* ISA wrapper (crypto cannot be held in a Stocks & Shares ISA), and crypto left Samurai's scope entirely on 2026-08-16 (ADR-0015's 2026-08-16 amendment; see `docs/adr/0015-live-venue-account-and-book-split.md`). David: *"actually drop crypto. we'll create a new system one later for handling crypto trades."*

So this research has two consumers — one of them Samurai's own near-term future, not a hypothetical successor:

1. **Samurai's own live equity leg, once #905 lands it on a GIA-permitting venue.** This is the ruled destination (2026-08-26: "we have to go with GIA only for day trading"), not speculative — only the specific venue (Saxo via #910, IBKR via #911) remains open. Once the leg moves, every equity disposal becomes a recordable, reportable CGT event (`docs/research/38-gia-relaxed-venue-rescore.md`'s finding, cited in ADR-0015), and this doc's mechanics become directly applicable.
2. The **future standalone crypto system** referenced above — crypto disposals are CGT events by default (no wrapper equivalent to an ISA exists for cryptoassets), so this system is also a first-order consumer of tax-loss harvesting mechanics.

Everything below is HMRC's own current published guidance, fetched live from gov.uk on 2026-08-26. Every claim is cited to the specific page it came from. Nothing here has been implemented, specced, or wayfinder-mapped — this is raw primary-source material for whichever future system inherits it to spec against.

## 1. The CGT annual exempt amount — current value, and it has been cut sharply

**Current value: £3,000 for individuals** (2024–25 tax year onward, and now "permanently fixed" rather than uprated with CPI). Source: [gov.uk — Capital Gains Tax: allowances](https://www.gov.uk/capital-gains-tax/allowances) ("The Capital Gains tax-free allowance is: £3,000" for individuals; £1,500 for most trustees).

This is a recent and large cut, confirmed against the official policy paper: [gov.uk — Capital Gains Tax: Annual Exempt Amount](https://www.gov.uk/government/publications/reducing-the-annual-exempt-amount-for-capital-gains-tax/capital-gains-tax-annual-exempt-amount).

| Tax year | Annual exempt amount (individuals) |
| --- | --- |
| 2022–23 | £12,300 |
| 2023–24 | £6,000 |
| 2024–25 onward | **£3,000** (fixed — CPI uprating abolished) |

Announced at Autumn Statement 2022, effective from 6 April 2023, stated rationale being "public finances on a sustainable path... with everyone contributing a little." The same policy paper also fixed a £50,000 reporting-limit figure (read here as the disposal-proceeds threshold, though this doc has not separately verified that gloss against the reporting-limit legislation).

**Why this matters for a future non-ISA account:** a £3,000 allowance is roughly a quarter of what it was three years ago. Any future GIA leg sized like Samurai's current book (hundreds to low thousands of pounds per position) could realise gains that consume the *entire* annual exempt amount on a handful of winning trades, making an offsetting loss-harvest materially more valuable per pound of loss than it would have been under the old £12,300 allowance. This is a reason to actually build loss-harvesting logic for a non-ISA leg, not a reason to assume it's immaterial (see also the ADR-0015 finding in §5 below).

## 2. Share matching rules — why selling and rebuying doesn't just work

This is the crux of the research: HMRC does not let you crystallise a loss (or a gain) by disposing of an asset and simply reacquiring an equivalent position days later. There are three matching rules, applied **in priority order**, that decide which specific acquisition a disposal is matched against for CGT computation purposes. Source: [gov.uk HMRC manual — CG51560: Share identification rules for capital gains tax from 6.4.2008](https://www.gov.uk/hmrc-internal-manuals/capital-gains-manual/cg51560).

**Priority order (highest first):**

1. **Same-day rule.** "All shares of the same class in the same company acquired by the same person on the same day and in the same capacity are treated as though they were acquired by a single transaction." If there is an acquisition and a disposal on the same day, the disposal is matched against that same-day acquisition first.
2. **30-day "bed and breakfasting" rule.** A disposal must be matched against acquisitions of the same class of share, in the same company, by the same person in the same capacity, made **within the 30 days following the disposal** (not preceding it — the rule looks forward). "This rule has priority over all other identification rules except the 'same day' rule." Consumer-facing summary: [gov.uk — Tax when you sell shares: Selling shares in the same company](https://www.gov.uk/tax-sell-shares/same-company) ("If you bought new shares of the same type in the same company within 30 days of selling your old ones, there are special rules for working out the cost to use in your tax calculations").
3. **Section 104 holding (the pool).** Anything not matched by rules 1 or 2 falls into — or is drawn from — the Section 104 pool: a single averaged holding of "cost per share" built up across every historical acquisition of that share/security that hasn't been separately matched.

**What "same class" means — read narrowly by this doc, not confirmed as a rejection of a broader test.** Every gov.uk source fetched for this doc scopes the matching rules to "shares of the same class in the same company" (CG51560) / "the same type of shares in a company" (the consumer page) — i.e. the same class of security issued by the same legal entity or fund. None of the pages fetched (CG51560, the consumer "same company" page, or CG51565 on relevant securities) states affirmatively that matching does *not* extend to a broader "substantially identical" test the way the US wash-sale rule is sometimes read — CG51565 in particular addresses only *timing* (FIFO/LIFO) for a narrow class of "relevant securities" and is silent on cross-instrument scope. **This doc's reading, not a quoted HMRC statement:** on the plain wording fetched, selling one ETF and buying a different (even economically near-identical) ETF from a different issuer looks unlikely to be matched by these rules, since the rules are worded around "the same company"/"same class" rather than economic similarity — but selling and rebuying units of the *exact same fund* within 30 days is squarely matched. A future system relying on this distinction should verify it against TCGA 1992 s105/s106A directly (legislation.gov.uk) or an HMRC/professional source that states the cross-instrument scope explicitly, rather than relying on this doc's inference.

**Why this matters mechanically:** if a future system sells a losing position intending to bank the loss and immediately buys the same instrument back (or would buy it back within 30 days on the next signal), HMRC's 30-day rule reattaches the disposal to that reacquisition instead of to the original (higher-cost) Section 104 pool cost. The effect is to **defer the loss, not eliminate it** — the loss becomes embedded in the cost basis of the new holding and only crystallises on a later disposal that isn't itself matched within 30 days. A signal-driven system that re-enters the same name inside a month (which an intraday/short-horizon strategy like Samurai's could easily do) would routinely have its "harvested" losses deferred by this rule without knowing it, unless the tax logic explicitly tracks the 30-day matching window per instrument.

## 3. Capital losses — how they carry forward if unused

Source: [gov.uk — Capital Gains Tax: Losses](https://www.gov.uk/capital-gains-tax/losses).

- A loss must be **claimed** — it is not automatic. It's claimed by including it on a Self Assessment return, or by writing to HMRC directly if not otherwise registered for Self Assessment.
- **Losses can be claimed up to 4 years after the end of the tax year** of disposal (an exception exists for losses from before 1996, which remain claimable).
- In the tax year of the loss, "the amount is deducted from the gains you made in the same tax year" first.
- If gains still exceed the annual exempt amount after current-year losses, **unused losses from previous tax years** are deducted next.
- Anything still unused after that **carries forward to future tax years** until fully used against gains — the gov.uk page states losses carry forward without stating any expiry, but this doc has not separately verified an explicit "no time limit" statement beyond that absence of a stated limit.
- **Restriction:** a loss cannot be claimed on a disposal to a spouse/civil partner or (with a narrow exception) another family member — relevant if any future multi-account or household structure is ever considered, though out of scope for a single-account trading system.

**Why this matters:** carried-forward losses are a standing asset a future system's tax-loss-harvesting logic would need to track across tax years, not just within one — a loss harvested in a year with insufficient offsetting gains isn't wasted, it's banked against future years indefinitely.

## 4. Crypto-specific HMRC guidance — the same mechanics, applied to token pools

HMRC's Cryptoassets Manual applies the **same statutory framework as shares** (TCGA 1992 s104 pooling, s105 same-day rule, s106A 30-day rule) to cryptoassets, with one structural difference: pooling is **per token type**, not per "company."

- **Pooling:** [gov.uk HMRC manual — CRYPTO22200: Cryptoassets for individuals: Capital Gains Tax: pooling](https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual/crypto22200). "Each type of token will need its own pool. For example, if a person owns bitcoin, ether and litecoin they would have three pools and each one would have its own 'pooled allowable cost' associated with it." Pooling applies because cryptoassets are, per statute, assets "of a nature to be dealt in without identifying the particular assets disposed of or acquired" (TCGA92/S104(3)(ii)) — the same test that puts fungible shares into a pool.
- **NFTs are excluded from pooling** — "Non-Fungible Tokens (NFTs) are separately identifiable and so are not pooled and no matching rules are applied" (same page). Not relevant to a fungible-token trading system, but worth knowing if instrument scope ever widens.
- **Same-day and 30-day rules apply identically in mechanism.** The same-day rule (s105) collapses same-day acquisitions/disposals of a token type into one computation. The 30-day rule (s106A) matches a disposal against acquisitions of the same token type made in the following 30 days, worked example at [gov.uk HMRC manual — CRYPTO22253](https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual/crypto22253): "Acquisitions within 30 days of a disposal are matched on the basis of the earliest acquisition being matched to a disposal" — walked through with a two-disposal, three-acquisition example (Rachel's case) showing partial matches and the remainder falling back to the Section 104 pool. Any tokens left unmatched after same-day and 30-day matching return to the pool.
- **No wrapper exemption exists for crypto.** Unlike equities, there is no ISA (or equivalent) that shelters cryptoasset disposals from CGT — every crypto disposal above the annual exempt amount is a taxable event by default. A crypto system trading spot crypto is CGT-exposed from day one; a GIA equity leg is CGT-exposed only once #905 lands the live leg on a GIA-permitting venue (ruled direction, venue still open per #910/#911) — both are real, not-yet-live consumers of this research, not one real and one hypothetical.

**Practical implication for a future crypto system:** because pooling and matching are per token type (not per venue, not per strategy), any system running frequent buy/sell cycles on the same token (e.g. BTC entered and exited multiple times within a month) will constantly re-trigger same-day and 30-day matching against its own pool. A naive "sell to harvest a loss, then re-enter on the next signal" approach will very often find its loss deferred into the reacquisition's cost basis rather than banked, exactly as with shares (§2) — the mechanism is identical, just scoped to token type instead of company/class.

## 5. Finding: ADR-0015's CGT framing should be corrected (not fixed here) — RESOLVED by #930

`docs/adr/0015-live-venue-account-and-book-split.md` stated, at two points, before this doc's own follow-up ticket landed:

- Line ~55 (as it read at research time): *"UK tax. CGT is immaterial at £1,500 against a £3,000 annual exempt amount, but every crypto disposal and equity trade is still a recordable event..."*
- Line ~143 (as it read at research time): *"The UK tax position is if anything looser: CGT was already immaterial at £1,500 against a £3,000 exempt amount."*

Both framed the ISA leg's CGT-free status as a **magnitude** argument — the book is small relative to the £3,000 allowance, so tax is "immaterial." That framing was **stale/wrong for the equity leg specifically**: the Trading 212 ISA wrapper exempts equity disposals from CGT **unconditionally**, regardless of size — see [gov.uk — Capital Gains Tax: What you pay it on](https://www.gov.uk/capital-gains-tax/what-you-pay-it-on) ("You do not pay Capital Gains Tax on certain assets, including any gains you make from: ISAs or PEPs"). The £3,000-allowance comparison never actually applied to the equity leg; it would only ever have been the right frame for the (now out-of-scope) crypto leg, which has no wrapper and was genuinely small enough to sit under the allowance.

**This doc did not edit the ADR itself — that was tracked separately as [#930](https://github.com/dd-jp/samurai-trading-system/issues/930), which is now closed and merged** (`docs(adr): correct ADR-0015 CGT-exempt framing to wrapper, not magnitude`). Both cited points now read "That is a wrapper exemption, not a magnitude one" and equivalent language, stating the ISA leg is CGT-exempt by wrapper (unconditional) rather than by size. This section is preserved as the record of the finding that prompted #930, not as an open item.

## Sources (fetched live 2026-08-26)

- [gov.uk — Capital Gains Tax: allowances](https://www.gov.uk/capital-gains-tax/allowances)
- [gov.uk — Capital Gains Tax: Annual Exempt Amount (policy paper)](https://www.gov.uk/government/publications/reducing-the-annual-exempt-amount-for-capital-gains-tax/capital-gains-tax-annual-exempt-amount)
- [gov.uk — Capital Gains Tax: Losses](https://www.gov.uk/capital-gains-tax/losses)
- [gov.uk HMRC manual — CG51560: Share identification rules for capital gains tax from 6.4.2008](https://www.gov.uk/hmrc-internal-manuals/capital-gains-manual/cg51560)
- [gov.uk — Tax when you sell shares: Selling shares in the same company](https://www.gov.uk/tax-sell-shares/same-company)
- [gov.uk — Tax when you sell shares: Work out your gain](https://www.gov.uk/tax-sell-shares/work-out-your-gain)
- [gov.uk HMRC manual — CRYPTO22200: Cryptoassets for individuals: Capital Gains Tax: pooling](https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual/crypto22200)
- [gov.uk HMRC manual — CRYPTO22253: worked example of the 30-day rule for cryptoassets](https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual/crypto22253)
- [gov.uk — Capital Gains Tax: What you pay it on](https://www.gov.uk/capital-gains-tax/what-you-pay-it-on)
- [gov.uk — Individual Savings Accounts (ISAs): How ISAs work](https://www.gov.uk/individual-savings-accounts/how-isas-work)

Note: [gov.uk HMRC manual — CG13370: Bed and breakfasting: shares and securities](https://www.gov.uk/hmrc-internal-manuals/capital-gains-manual/cg13370) was checked and the page returns an HMRC "archived" banner — the substantive explanatory text was not retrievable from it at fetch time. CG51560 is the live page for the same subject matter and is what this doc cites throughout.
