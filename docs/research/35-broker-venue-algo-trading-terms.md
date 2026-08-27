# 35 — Broker venue terms: which UK-accessible platform permits algorithmic trading

**Researched 2026-08-19** for [#896](https://github.com/dd-jp/samurai-trading-system/issues/896) (BLOCKING(venue)). Continues [`34-lse-mark-source-options.md`](34-lse-mark-source-options.md), which raised the venue question while hunting a mark source. **This doc decides nothing** — the venue is David's call under #896.

> **Why `35`.** The `30`s band is nominally "data vendors", but this is doc 34's direct continuation: 34 is what found API Terms 4.2(a) and spawned #896, and a reader arriving at 34 looks next to it. The `40`s hold infra/tooling (dashboard hosting, tick latency), not vendor-or-venue selection, so `42` would file this away from its only inbound link. `35` was unused.

## TL;DR — both halves of the question

**Part 1 — who permits algorithmic trading under their own terms?** **A minority, and the permission does not travel with the ISA by default.** Explicitly permitted **(a)**: **IBKR UK** (TWS API Non-Commercial Licence §1.2 — the licence's own definition of permitted use includes *"enter orders… in connection with Your account at IB"*), **Saxo UK** — **(a)/(c)**, weaker in kind than the others: it rests on *absence* of a prohibition in the General Business Terms plus a live-credential grant for *"personal usage"*, not on an affirmative permission, and **no Saxo OpenAPI terms-of-use document could be located at any URL** (see Unresolved), **eToro UK** (T&C 13.8), and the US brokers **Alpaca**, **Tastytrade** and **TradeStation** — the last only *attended*. Permitted **only with prior written consent (d)**: **IG** (Share Dealing Term 10(12); the ISA Supplementary Terms' exclusion list omits Term 10, which *implies* the gate reaches the ISA — an inference from an absence, not a quoted clause), **Darwinex** (9.6, prohibited by default), and Pepperstone's platform terms. **Explicitly prohibited (b)**: Trading 212 (all lines), **Lightyear** 4.1.7, **Hargreaves Lansdown** AUP 3.1.8, **CMC Invest** 29.3(g), **Plus500** 15.16, **Capital.com** B.3.1 (which publishes a full trading API anyway), **Vanguard** 1.3.4. **Silent (c)**: Freetrade, InvestEngine, AJ Bell, interactive investor, XTB, Spreadex — all of which also have **no order-placing API**, so silence there is not an opening.

**Part 2 — does any Trading 212 product line permit algorithmic trading?** **No. Every T212 product line that can place a trade prohibits it, and each prohibition is self-contained** — dropping the API does not escape it, and neither does switching product:

| T212 product line | Governing clause | Status |
|---|---|---|
| Invest (GIA) | Invest Terms **5.1** — *"Share Dealing Services"* | **(b) prohibited** |
| **Stocks ISA** | Invest Terms 5.1, imported by ISA Terms **1.1/1.2** | **(b) prohibited** |
| **CFD** | CFD Terms **3.7** — *"our Services"*, i.e. CFD dealing (CFD Terms 4.1) | **(b) prohibited** |
| Pies / AutoInvest | Pies and AutoInvest Terms 1.1 — Invest Terms apply *mutatis mutandis*; no carve-out | **(b) prohibited** |
| SIPP | Same 5.1; additionally not API-reachable | **(b) prohibited** |
| Cash ISA | No dealing service at all | **N/A** — not permission |
| The API itself | API Terms **4.2(a)** | **(b) prohibited** |

**The CFD line is not killed by API scope — it is killed by CFD Terms 3.7 on its own.** That matters: the T212 public API is documented as *"enabled and usable only for Invest and Stocks ISA account types"*, so a reader could conclude that CFDs merely lack API access and would be fine with it. They would not: 3.7 prohibits using the CFD *Services* for Algorithmic Trading in exactly the way 5.1 prohibits it for share dealing, with the same §-definition and the same right of unilateral account closure. There is no T212 branch — product, wrapper or access channel — on which Samurai's posture is permitted as written.

**The wider finding — the constraint set is nearly, but not quite, unsatisfiable.** Four constraints: a UK Stocks & Shares ISA, a real order-placing API, algorithmic trading permitted in the venue's own terms, and cost viability at ADR-0018 D5's £350/£250 tickets. **Two candidates clear all four on the documents, each with one unverified precondition:**

- **Saxo UK** — ISA, OpenAPI, no algo bar in the General Business Terms, and **8 bps per side with no per-order minimum = 0.16% round trip at both ticket sizes**. The cheapest permitted venue found by an order of magnitude. Unverified: that an ISA sub-account is tradeable over OpenAPI (Saxo publishes nothing either way).
- **IBKR UK** — ISA (HMRC manager Z2056), the most explicit algo permission of any venue surveyed, but **£3/order minimum = 1.71% round trip on £350 and 2.40% on £250**, plus a £3/month ISA activity fee (£36/yr = **3.6%/yr** of the £1,000 book). Unverified: the same ISA-over-API question.

**IG** is the near miss and the interesting one: £0 commission on GBP LSE lines, a real API — but the API is *"OTC"* only with *"Direct market access… not currently available"*, so it does not reach the share-dealing/ISA entity, and automation needs IG's prior written consent in any case.

**Everything else fails on at least one hard constraint**, most often "no API at all" (the UK retail-ISA platforms) or "no ISA at all" (the CFD/spread-bet venues and the US brokers). **A shared, unresolved risk sits above all of them:** no firm's documents establish that ADR-0016's LSE **leveraged ETPs** — commonly ETC/ETN-structured — are ISA-qualifying investments at their venue. IBKR's ISA permission profile reads *"Stock Only"*; Saxo enumerates *"stocks, bonds, ETFs and funds"* and omits ETCs/ETNs.

## Method and provenance

Primary sources only, all fetched **2026-08-19**. Trading 212 PDFs were downloaded with `curl` from `trading212.com` (HTTP 200, clean text layer) and extracted locally; quotes below are verbatim with T212's own clause numbers.

- API Terms — `https://www.trading212.com/legal-documentation/API-Terms_EN.pdf` — *"last updated and published on 17.10.2025"*
- Invest Terms — `https://www.trading212.com/legal-documentation/uk/invest/Invest-Terms_EN.pdf` — *"last upd ated and published on 07.08.2026"*
- ISA Terms — `https://www.trading212.com/legal-documentation/uk/isa/ISA-Terms_EN.pdf` — *"The ISA Terms relevant before 25.11.2025 can be found here"*
- CFD Terms — `https://www.trading212.com/legal-documentation/uk/cfd/CFD-Terms_EN.pdf` — *"The CFD Terms relevant before 04.02.2026 can be found here"*
- Pies and AutoInvest Terms — `https://www.trading212.com/legal-documentation/uk/invest/Pies-and-AutoInvest-Terms_EN.pdf`
- Order Execution Policy — `https://www.trading212.com/legal-documentation/uk/common/Order-Execution-Policy_EN.pdf` — *"last updated and published on 26.03.2026"*

**The API Terms 4.2(a), §11, 6.2, 6.3, 6.6, 6.7, 7.1(b), 4.2(b)(2) and Invest Terms 5.1 / 20.2 quotes recorded in [#896](https://github.com/dd-jp/samurai-trading-system/issues/896) were re-fetched and confirmed verbatim** against these copies. They are not re-derived here. What follows is the **delta**: the per-product-line question #896 did not answer, and the alternatives survey.

## Trading 212 — per product line

**Legal entity, all UK product lines:** Trading 212 UK Ltd., Aldermary House, 10-15 Queen Street, London, EC4N 1TX, company number 08590005, *"authorised and regulated by the Financial Conduct Authority of the United Kingdom… FCA register number is 609146"* (Invest Terms 1.2/1.4; CFD Terms 1.2 gives the same entity and FCA number, at the older Cheapside address in some documents). **One entity governs Invest, ISA and CFD** — the product lines are separate agreements, not separate firms.

### Invest (GIA) and Stocks ISA — prohibited

**Invest Terms 5.1** (fetched 2026-08-19, `.../uk/invest/Invest-Terms_EN.pdf`):

> "5.1. You acknowledge that you are not permitted to open and/or operate an Invest Account with us on a third party's behalf, regardless of your legal relations. **You are expressly prohibited from making use of our Share Dealing Services for Algorithmic Trading purposes** or for providing any commercial services, such as agent, brokerage and/or asset management services, regardless of the fact that such services may be legally authorised. We reserve the right to unilaterally close any such Invest Account that we become aware of, and we shall not be liable for any losses, damages, costs, or expenses arising from our actions under this clause."

**Invest Terms 36 (definitions)** carries the same definition the API Terms use:

> "**Algorithmic Trading** means any kind of trading in Instruments where a computer algorithm automatically determines individual parameters of Orders, such as whether to initiate the Order, the timing of execution, price or quantity of the Order, or how to manage the Order after its submission…"

**The ISA inherits it.** ISA Terms 1.1: *"These Individual Savings Account Terms ("ISA Terms") contain **additional terms and conditions to the Invest Terms**… a. Stocks and Shares ISA ("Stocks ISA"); and b. Cash ISA ("Cash ISA")."* ISA Terms 1.2: *"**The provisions of the Invest Terms shall be applied to the following ISA Terms.** In case of any inconsistencies, these ISA Terms shall take precedence over the Invest Terms."* Invest Terms 4.7 states the same from the other side: *"Your Stocks ISA Account and Cash ISA Account and any ISA Services shall be governed by the ISA Terms available on our Website, **in addition to the present Invest Terms**."* The ISA Terms contain **no** occurrence of "Algorithmic" — there is no carve-out, so 5.1 flows through unmodified.

**Enforcement teeth, on the equity side specifically.** Invest Terms 20.1 additionally forbids Transactions qualifying as *"b. Scalping"* — defined at Invest Terms 36 as *"a speculative type of trading where the opening and closing of a position is executed within a very short timeframe (e.g. five minutes or less)"* — and 20.2: *"In case of any breach, we shall have the right to **cancel or void any Order or trade** made in violation of Clause 20.1. (regardless of whether the Position is still open or closed), to **close your Invest Account, Stocks ISA Account and/or SIPP Account**…"*

### CFD — prohibited, independently of the API

**CFD Terms 3.7** (fetched 2026-08-19, `.../uk/cfd/CFD-Terms_EN.pdf`, pages 4–5):

> "3.7. You acknowledge that you are not allowed to open and/or operate an Account with us on a third party's behalf, regardless of your legal relations. **You are expressly prohibited from making use of our Services for Algorithmic Trading purposes** as well as for providing any commercial services, such as agent, brokerage and/or asset management services, regardless of the fact that such a service may or may not be legally authorised. **We shall have the right to unilaterally close any such Account** that we become aware of and we shall not be liable for any losses, damages, costs, or expenses arising from our actions under this clause."

*"Services"* is defined at CFD Terms **31 (Definitions)** as *"the services we provide for trading CFDs as specified in Clause 4.1."* — so 3.7 reaches CFD dealing by any channel, not just an API. The CFD Terms' definitions clause **31** carries the identical **Algorithmic Trading** definition (*"any kind of trading in Instruments where a computer algorithm automatically determines individual parameters of Orders…"*), the identical **Scalping** definition (*"…within a very short timeframe (e.g. five minutes or less)"*), and a market-abuse undertaking at **21.1(f)** mirroring Invest 20.1 (*"you shall not act in any way other than in the normal course of business or seek to manipulate the relevant financial market… i. Market abuse…; ii. Scalping;…"*), enforced by **21.2** (*"…entitle us to unilaterally cancel and deem void any Order…"*).

**Separately, CFDs are not ISA-eligible anyway**, so this line could not have hosted the live book without abandoning the wrapper — see the tax-wrapper section.

### The API's product scope — corroborating, not load-bearing

Trading 212's API documentation states: *"**The API described here is enabled and usable only for Invest and Stocks ISA account types.**"* (`https://docs.trading212.com/api/section/general-information/only-for-invest-and-stocks-isa`, fetched 2026-08-19). The help centre agrees: *"Currently, the Public API section is visible only for the General Invest Account and the Stock & Shares ISA Account"* and *"The Trading 212 Public API is not currently available for SIPP accounts"* (`https://helpcentre.trading212.com/hc/en-us/articles/14584770928157-Trading-212-API-key`, fetched 2026-08-19).

The API Terms agree by omission — 1.1 binds the key-holder *"along with our **Invest, Pies & AutoInvest Terms and/or ISA Terms**, as applicable"*, and 12.1 imports undefined terms from the same three documents. **The CFD Terms are named nowhere in the API Terms.**

An unauthenticated probe of `live.trading212.com/api/v0/` on 2026-08-19 corroborates: `equity/account/cash` and `equity/portfolio` return **401** (exists, auth required) while `cfd/account/cash`, `cfd/positions` and `cfd/metadata/instruments` return **404**, the same as a control path `nonsense/foo`. This is corroboration only — an authenticated CFD key could in principle route differently, which an unauthenticated probe cannot rule out.

**Read this the right way round:** API scope is *why the CFD line cannot be automated in practice*; CFD Terms 3.7 is *why it may not be automated at all*. The second does not depend on the first.

### Pies / AutoInvest — the asymmetry worth naming

Pies and AutoInvest Terms 1.1: *"These Additional Terms for Investment Pies ("the Terms") govern the relationship between you and Trading 212 UK Ltd… **The Invest Terms and any definitions not defined in these Terms shall be applied mutatis mutandis to the Terms.** In case of any inconsistencies, the Terms shall take precedence over the Invest Terms."* The document contains **no** occurrence of "Algorithmic" — no carve-out, so 5.1 applies.

**The asymmetry is real but does not help.** AutoInvest is *"a Feature that enables you to set up recurring [orders]… for fixed amounts that happen periodically and on an ongoing basis as chosen by you with no specified end date until terminated by you"*, and Pies rebalance and reinvest dividends automatically (4.5: *"AutoInvest will allocate the deposited funds automatically in proportion to the targeted Weight of each Slice"*). That is a computer determining *timing* and *quantity* of orders with no human intervention — squarely inside T212's own §-definition of Algorithmic Trading. The difference is **whose** algorithm: T212 permits its own scheduled-investing engine and prohibits the client's. Nothing in the Pies Terms extends that permission to a client-supplied strategy, and Pies are long-only, calendar-scheduled and unsuited to an intraday flat-by-close bracket in any case.

### Cash ISA — N/A

ISA Terms 1.1 lists the Cash ISA as an ISA account, but it is a cash deposit product with no dealing service, so there is nothing to automate. This is "not applicable", not "permitted".

### Also confirmed, unchanged from #896 / doc 34

- **API Terms 6.2** — the licence is *"solely for your personal use (and not for managing assets of a third party in any capacity) and **only for testing purposes**"*.
- **API Terms 7.1(b)** — *"**You will not receive real-time information on Market Data**"*.
- **The three written-consent routes are 6.3 (apps for other end-users), 6.6 (*"any high-speed or automated mass data entry system"*) and 6.7 (customised interfaces). None is a consent route for Algorithmic Trading; 4.2(a) has no exception and names no process.**
- **The docs contradict the terms, and still do.** `https://docs.trading212.com/api/orders` (fetched 2026-08-19): *"Place, monitor, and cancel equity trade orders. This section provides the core functionality for **programmatically executing your trading strategies** for stocks and ETFs."* Documentation is not terms; where they conflict, API Terms 1.2 gives the terms priority.
- **Non-idempotent orders, confirmed on the current docs host:** *"In this beta version, this endpoint is not idempotent. Sending the same request multiple times may result in duplicate orders."* — applied to Limit, Market, Stop and StopLimit. Rate limits as documented: market orders 50/min, limit/stop/stop-limit 1 per 2s, cancels 50/min. This conflicts with `CLAUDE.md`'s "idempotent order IDs" constraint and needs its own ticket if T212 survives.

## Comparison table — UK-accessible platforms

Algo column: **(a)** explicitly permitted · **(b)** explicitly prohibited · **(c)** silent/ambiguous · **(d)** prior written consent / professional-client only. Costs are **round trip** on ADR-0018 D5's ticket sizes. All fetched 2026-08-19.

| Platform (entity, FCA no.) | S&S ISA | Order API | Algo clause | Round trip £350 / £250 | Fails on |
|---|---|---|---|---|---|
| **Trading 212** (T212 UK Ltd, 609146) | Yes | Yes (Invest+ISA) | **(b)** API 4.2(a); Invest 5.1; CFD 3.7 | ~£0 (no commission, no SDRT on ETFs, GBP) | **algo** |
| **Saxo** (Saxo Capital Markets UK, 551422) | Yes | Yes — OpenAPI, live creds for "personal usage" | **(a)/(c)** GBT has no algo bar (only 27.4(vii) anti-manipulation) — silence, not a grant; no OpenAPI ToU found | **0.16% / 0.16%** (8 bps/side, no minimum) | ISA-over-API **unverified** |
| **IBKR UK** (IB (U.K.) Ltd, 208159) | Yes (HMRC mgr Z2056) | Yes — TWS/Web API | **(a)** TWS API licence §1.2 "enter orders", non-commercial | **1.71% / 2.40%** Fixed; 0.57%/0.80% Tiered (SmartRouted API only) | **cost** + ISA-over-API unverified |
| **IG** (IGTI 944492 / Markets 195355 / Index 114059) | Yes (IGTI) | Yes — but REST is **OTC only**, "DMA not available" | **(d)** Share Dealing 10(12) + 19(1)(m), reaches the ISA | £0 commission on GBP LSE lines | **API** (doesn't reach the ISA) + consent |
| **CMC Markets** (UK plc 173730 / Invest 948126) | Yes (Invest) | No retail API (CMC Connect = institutional) | **(b)** for Invest (29.3(g)); **(a)-ish** for UK plc via API carve-out in 10.2.3 | £0 commission; ISA needs Plus ≤£6.99/mo | **API**, and algo for the ISA entity |
| **XTB UK** (XTB Ltd, 522157) | Yes | No retail API published (xAPI = institutional X Open Hub) | **(c)** 37.2(f) bars "automated mass data entry"; 41.2(f) contemplates EAs | ~£0 (0% to €100k/mo, £1 min investment) | **API** |
| **Freetrade** (783189) | Yes | **No API** | **(c)** none found in T&Cs v4.9 | £0 | API |
| **Lightyear** (987226) | Yes | **No** — "We don't offer an API" | **(b)** ToS 4.1.7 (bites on UI automation too) | £0 | API + algo |
| **InvestEngine** (801128) | Yes | No API; one daily dealing cycle | **(c)** none found | £0 | API + **daily dealing** |
| **Hargreaves Lansdown** (115248) | Yes | No API | **(b)** AUP §3.1.8 (AI/bots) | £13.90 (3.97%) / £13.90 (5.56%) at the 0–19-deals/mo rate; £7.90 (2.26%/3.16%) at 20+ | API + algo + cost |
| **AJ Bell** (155593) | Yes | No API; 18.6 limits channels | **(c)** none found | £10.00 (2.86%) / £10.00 (4.00%) | API + cost |
| **interactive investor** (141282) | Yes | No API; ToS 3.2 limits channels | **(c)** none found | £7.98 + £71.88/yr plan | API + cost |
| **Vanguard UK** (527839) | Yes | No API; online dealing only | **(b)** 1.3.4 bars "third-party automated agents" | £0 bulk (2 windows/day) or £15.00; £48/yr | API + algo + dealing windows + universe (Vanguard funds only) |
| **Spreadex** (190941) | No | No | **(c)** silent | spread ~0.7% | wrapper + API |
| **Plus500** (509909) | No | No | **(b)** §15.16 "All Transactions must be completed manually"; §25.1.4 scalping | spread only | wrapper + API + algo |
| **Capital.com** (793714) | No | **Yes** — full public REST/WS | **(b)** T&Cs B.3.1 "all instructions should be placed manually" | spread only | wrapper + algo |
| **eToro UK** (583263) | ISA is **third-party** (Moneyfarm, 629539) | Yes (T&C 13.8) | **(a)** 13.8 permits API/MCP order transmission | 0% commission | wrapper (ISA not eToro's) |
| **Pepperstone** (684312) | No | EAs on MT4/5/cTrader only | **(d)-ish** Platform T&Cs: "contact us to ensure the appropriate authority is provided" | 0.10%/side CFD | wrapper |
| **Darwinex** (586466) | No | FIX 4.4 + MT4/5 | **(d)** Client Agreement 9.6 — prohibited by default without prior written consent | N/A (no LSE physical) | wrapper + LSE |
| **Tastytrade** (no UK entity; US BD) | No | Yes | **(a)** Open API T&Cs §13(2) "algorithmic trading systems"; §3 Autotrading | N/A | **no FCA entity**, no LSE |
| **TradeStation** (TSIL 445531 introducing US TSS) | No | Yes | **(a)** but §10 requires attendance: "not designed to allow you to leave your computer… unattended" | N/A | $10k API minimum, no LSE, **attended-only** |
| **Alpaca** (Alpaca Securities LLC, US BD) | No | Yes | **(a)** "customers who can write automated investment code"; no HFT | N/A for LSE | **no wrapper, no LSE** (roadmap) |
| **Tradier** (US BD) | No | Yes | (c) | N/A | **UK residents blocked** |

## Per-platform detail — the candidates that matter

### Saxo Capital Markets UK Ltd (FRN 551422) — the cheapest venue that permits it

- **ISA:** *"A stocks and shares ISA provides access to more than 18,000 Stocks, ETFs, Funds and Bonds. After opening your account and logging into our platform, all the visible products are ISA eligible."* — `https://www.home.saxo/en-gb/accounts/isa`. No minimum funding (`https://www.help.saxo/hc/en-gb/articles/360001253983-What-is-the-minimum-funding-amount`).
- **API:** OpenAPI, with live credentials granted to *"A direct retail or professional client of Saxo Group, [who] would like to create an application for **personal usage**"* — `https://www.developer.saxo/openapi/learn/direct-clients-request-for-openapi-application-credentials-for-the-live-environ`. A funded live account and a prior SIM application are preconditions; approval is *"in most cases… handled automatically"*.
- **Algo — (a)/(c), by permissive silence plus a personal-use grant, and weaker in kind than IBKR's.** IBKR names order entry as a permitted use; Saxo merely fails to forbid automation, and the document that would govern API use specifically — an OpenAPI terms of use — **could not be located at any reachable URL**, so the GBT below is the only binding text quotable here. Treat this as the classification most likely to move on one support answer. The **General Business Terms UK** (57pp, 06/04/2025, `https://www.home.saxo/-/media/documents/regional/uk/legal-documentation/general-business-terms-uk.pdf`) clause 9 ("Use of the Trading Platforms") contains **no** prohibition on automated, algorithmic or systematic trading. The only algorithm clause is **27.4(vii)**: *"you will not use any electronic device, software, algorithm or any trading strategy that **aims to manipulate or take unfair advantage** of the Services."* That is an anti-abuse undertaking, not an algo ban — and the GBT defines *"'API' means Application Programming Interface for the use of alternative trading interfaces or platforms"*, i.e. the channel is contemplated.
- **Cost — the decisive number.** LSE commission **8 bps** (Classic tier), *"**No minimums on UK stocks**"* (`https://www.home.saxo/en-gb/rates-and-conditions/stocks/commissions`; rate from `https://www.help.saxo/hc/en-gb/articles/30822149576349-Saxo-UK-pricing-update-Effective-15-November-2025`). **£0.56 round trip on £350 (0.16%) and £0.40 on £250 (0.16%)** — proportional, so it does not punish D5's small tickets. Custody 0.12%/yr (£1.20 on £1,000); *"We do not charge any inactivity fees."*
- **Market data:** LSE L1 Private **£7.00/month**, *"refunded… should clients trade a minimum of four (4) times… during each calendar month"* — effectively free for a daily system. **Whether that entitlement flows through OpenAPI is unresolved** (see Unresolved).
- **Two live risks.** (1) *"Can I trade derivatives in my ISA? **No** — individual savings accounts only provide access to cash products, such as stocks, bonds, ETFs and funds"* — ETCs/ETNs are not named, and ADR-0016's leveraged ETPs are commonly ETC/ETN-structured. (2) The commissions schedule flags that *"market-made instruments on the LSE… must be executed with the help of the trading desk"* — desk-executed instruments cannot be automated at all.

### Interactive Brokers (U.K.) Limited (FRN 208159) — the clearest permission, the worst cost

- **ISA:** *"If you are a U.K. resident for tax purposes and at least age 18, you can open a Stocks and Shares Individual Savings Account (ISA)"*; *"Interactive Brokers (U.K.) Limited is an approved HM Revenue & Customs Individual Savings Account (ISA) Manager - reference: Z2056"*; *"All ISA accounts are cash only, no margin"*; *"For advanced investors, we also offer access to our Trader Workstation (TWS) trading platform and APIs."* — `https://www.interactivebrokers.co.uk/en/accounts/isa-accounts.php`. IBKR Campus records the ISA permission profile as *"Stock Only – No other asset types permitted"* and mandatory ISA↔GIA account coupling (`https://www.interactivebrokers.com/campus/ibkr-api-page/test-for-uk-residents/`).
- **Algo — (a), explicitly.** TWS API Non-Commercial License §1.2 defines *"Non-Commercial Purposes"* as use that *"allow[s] You to access Your account information, access market data, perform analytics, **enter orders**, or perform any other transactions or functions all in connection with Your account at IB"*, licensed by §2.1 (`https://interactivebrokers.github.io/`). The licence's exclusions are about **selling or distributing** software to third parties (§0, §3.1, §3.3) — not about automating your own account. **No IBUK clause prohibiting automated or systematic trading was found.** This is the exact inverse of T212's 4.2(a).
- **Cost — where ADR-0015's rejection must be carried forward, and sharpened.** `https://www.interactivebrokers.co.uk/en/pricing/commissions-stocks-europe.php`: GBP-denominated UK stocks are *"0.05% of Trade Value"* with *"Minimum per order (shares): GBP 1.00 [Tiered] / GBP 3.00 [Fixed SmartRouting] / GBP 4.00 [Fixed Direct]"*. At D5 sizes the minimum binds in every tier (£350 × 0.05% = £0.175):

  | Structure | Round trip | on £350 | on £250 |
  |---|---|---|---|
  | Fixed – SmartRouting (retail default) | £6.00 | **1.71%** | **2.40%** |
  | Tiered | £2.00 | 0.57% | 0.80% |
  | Fixed – Direct Routing | £8.00 | 2.29% | 3.20% |

  And the API narrows the escape: *"**directed API orders cannot use the Tiered fee structure. SmartRouted API orders can use either the Tiered or Fixed structure.**"* On top of that the ISA carries *"a minimum monthly activity fee of £3"* = **£36/yr, a 3.6% standing drag on the £1,000 book**, plus LSE UK (L1) at *"GBP 1.00"*/month non-professional (`https://www.interactivebrokers.co.uk/en/pricing/research-news-marketdata.php`, which also states the USD 500 minimum equity to hold a data subscription — £1,000 clears it).
- **Unproven precondition:** no IBKR document names **ISA + order-entry API** together. The Web API docs say *"While the Trading functionality is available to all accountholders…"* and *"Permissions for trading… are carried by IB usernames, not the underlying accounts"*, and the ISA page offers "APIs" — strong but circumstantial.

### IG — permission is obtainable, but the API cannot reach the ISA

IG's REST/streaming API is real (`https://labs.ig.com/`) but its own getting-started page states the limits: *"**Direct market access is not currently available for our APIs**"* and *"Shares trading is available but without share price information"*, with the FAQ scoping it to *"**OTC trading** in any market instrument available to your account via our dealing platform"*. The ISA sits with a different entity (IG Trading and Investments Ltd, FRN 944492) from the API-documented CFD/spread-bet entities.

Its automation clause is the survey's clearest **(d)** — Share Dealing Customer Agreement (Feb 2026) **Term 10(12)**: *"You will not use any automated software, algorithm or trading strategy other than those that we make available to you on our Electronic Trading Services **without our prior written consent**. If we agree to allow you to use any such techniques, you agree that we may require you to comply with certain conditions… and that we may withdraw our consent at any time."* Term 19(1)(m) separately gates the *channel* (FIX/REST). **The ISA Supplementary Terms (Feb 2026) 1(8) exclusion list does not exclude Term 10 or 19(1)**, so the gate reaches the ISA.

Cost is the survey's best: *"Commission: Free — Platform fee: Free — FX fee: 0.49%… Custody/inactivity fee: Free"* (`https://www.ig.com/uk/charges`), i.e. **£0 round trip on a GBP LSE line**. So IG is the one venue where the blocker is a *process* (ask for written consent) plus an *engineering* gap (no API into the ISA), rather than a flat prohibition.

### The explicit prohibitions — T212 is not an outlier

- **Lightyear** ToS **4.1.7**: *"you will not use any algorithms or electronic trading programs or systems **to interact with the Lightyear App**"* — bites on UI automation too. Also *"We don't offer an API or other similar functions at this time."*
- **Hargreaves Lansdown** Acceptable Use Policy **§3.1.8**, grounds for suspension/closure: *"Where a client is suspected of using AI or transactional / commerce bots (or any other similar technology) to place trades via the HL platform"* — while §2.2.2 expressly permits *"Day trading within an individual's account"*. The mechanism is banned, not the strategy. Incorporated by the client terms.
- **CMC Invest** (FRN 948126, the entity that holds the ISA) General Terms **29.3(g)**: *"You must not… use: (i) any software, algorithm, robot, applications, tools, codes, computer, electronic devices or equipment on our Application for non-human and/or high frequency trading; or (ii) our Application or any of the Elements for automated purposes"*, with 29.3(f) closing screen-scraping. **CMC Markets UK plc** (173730, the CFD/spread-bet entity) has the same clause at 10.2.3 **with an API carve-out** — but publishes no retail API and offers no ISA.
- **Plus500** User Agreement **§15.16**: *"Use of any automated data entry system with the Trading Platform is expressly prohibited. **All Transactions must be completed manually by you.** Any Transaction completed through such use… shall be null and void"*, plus a scalping bar at §25.1.4 (positions closed within three minutes).
- **Capital.com** — the sharpest repeat of the #896 pattern: a fully public REST/WebSocket trading API at `https://open-api.capital.com/` with a sample RSI trading bot, against T&Cs Section B **3.1**: *"You accept that **all instructions should be placed manually** and any use of an automated data entry system… is expressly and strictly prohibited."* Docs are not terms — the same lesson as T212's Orders page.
- **Vanguard UK** Client Terms **1.3.4**: *"This includes third-party automated agents, delegated software or tools that act on your behalf."* Moot anyway — *"you can only acquire and deal in Vanguard Funds under these Terms"*.

### The US brokers — permission without a wrapper

- **Alpaca** (Alpaca Securities LLC, US BD) permits it as its whole premise — *"Brokerage services are provided to customers who can write automated investment code and self-direct their own investments"* (`https://alpaca.markets/international`) — with two limits from `https://files.alpaca.markets/disclosures/library/RisksAutoTrading.pdf`: *"Alpaca initially will only support algorithms that run on your own computer"* and *"**No High Frequency Trading.**"* UK residents can open a live account (`https://alpaca.markets/learn/live-trading-account-non-us`, updated 11 March 2026, uses the UK as its worked example and accepts a UTR or NINO; `https://alpaca.markets/support/requirements-alpaca-brokerage-account` lifted the $30,000 non-US minimum to $1). **But there is no ISA** — Alpaca's account types are *"individuals (non-retirement) and entities"* — and **no LSE**: LSE is named only as roadmap alongside Hong Kong, Saudi, Euronext Paris and Korea, B2B-first via Broker API, no date. Note a live contradiction in Alpaca's own paperwork: the Terms & Conditions PDF is headed *"U.S. Residents Only"* while the Customer Agreement expressly contemplates *"Non-Domestic Customer"* and Form W-8.
- **TradeStation** permits automation in terms — Terms of Business §10 — but with a clause that collides with **ADR-0007** head-on: *"Automated trading functionality is **not designed to allow you to leave your computer, screen or mobile phone unattended**… [you agree] to monitor the trading activity in your Account **at all times**."* API access requires *"a minimum balance of $10,000"*, ~10x the book, and a UK client gets *"major US listed markets"* — no LSE.
- **Tradier** is eliminated on eligibility: *"Tradier Brokerage CANNOT open accounts for people residing in the following countries"* — the list includes *"United Kingdom of Great Britain and Northern Ireland"*.



## Tax wrappers — what the alternatives cost in wrapper terms

Samurai's live book is **£1,000 inside a Stocks & Shares ISA** (ADR-0015's 2026-08-18 amendment). Any venue change is therefore also a wrapper change, and the wrapper is not a detail:

- **CFDs and spread bets cannot be held in an ISA.** ISA-eligible investments are set by the Individual Savings Account Regulations 1998 and HMRC's ISA guidance for managers, which admit shares, securities, funds and cash — derivatives such as CFDs and spread bets are not qualifying investments (HMRC, *Stocks and shares ISA investments for ISA managers*, `https://www.gov.uk/guidance/stocks-and-shares-investments-for-isa-managers`, last updated 6 April 2026, fetched 2026-08-19 — the qualifying list is shares/securities/funds/cash meeting the listing conditions, and derivatives are not among them; collection index `https://www.gov.uk/government/collections/isa-managers-guidance`). Moving to a CFD venue does not "lose the ISA" as a fee — it moves the whole book outside the wrapper.
- **UK spread betting is exempt from both stamp duty (SDRT) and CGT** for a retail punter, which is the one structure that beats an ISA on cost at this size — no 0.5% SDRT (already avoided by the ETF/ETC restriction) and no CGT. **Recorded, not recommended.** It is leverage stacked on ADR-0016's already-3x leveraged-ETP universe, the counterparty is the venue rather than the market, and HMRC treats spread-bet losses as non-deductible. It also changes the instrument: a spread bet on an ETP is not the ETP.
- **A US brokerage account (e.g. Alpaca) carries no UK wrapper at all** — gains are within scope of UK CGT, dividends need a W-8BEN, and the £1,000 book loses the shelter entirely. At £1,000 against a £3,000 annual exempt amount the *tax* is immaterial by magnitude — that argument genuinely applies here, since Alpaca has no ISA wrapper to be exempt by instead (see ADR-0015's UK tax note on the equity leg's own wrapper-dependent exemption, and [`38-gia-relaxed-venue-rescore.md`](38-gia-relaxed-venue-rescore.md) for the pending GIA-only ruling that would put the equity leg in the same wrapper-less position this line describes). So the wrapper's practical value here is **reporting simplicity**, not tax saved. That is a real but small stake — worth naming so the ISA is not defended out of habit.

## What this means for ADR-0015 / the T212 ISA venue decision

**This doc decides nothing.** #896 is David's call and remains open. What it adds to #896:

1. **The prohibition is total across T212, not API-specific.** #896 established API Terms 4.2(a) and Invest 5.1. This doc closes the remaining branches: **CFD Terms 3.7** prohibits it for CFDs by a clause that does not mention the API, Pies/AutoInvest inherits 5.1 with no carve-out, and the Cash ISA has no dealing service. **There is no T212 product line to migrate to.** ADR-0015's "equity venue: Trading 212 ISA" cannot be rescued by changing product within T212 — only by consent, by changing venue, or by knowingly accepting the risk.
2. **#896's option 2 (move to IBKR) must carry ADR-0015's own cost rejection forward.** ADR-0015 rejected IBKR on the grounds that *"a £3/trade floor is 0.6% round trip at this size, worse than the edge"* — computed against ~£1,000 of notional. **At ADR-0018 D5's resolved ticket sizes the same floor is far worse**: a £3-per-side minimum is **~1.71% round trip on a £350 index position** and **~2.40% on a £250 single-stock position**, against per-trade geometry bars of ~1.3–7.2 pp (doc 52) and break-even accuracy already at 51.3–57.2% before costs (doc 54). Any commission floor is the dominant term at these sizes; see the per-platform commission figures in the survey above for the schedule each candidate actually publishes.
3. **The option space has a real answer, and #896 should be decided against it rather than against "T212 or nothing".** T212 satisfies three of the four constraints (it is the *cheapest* venue for exactly this universe: no commission, no SDRT on ETFs/ETCs, no FX on GBP lines) and fails only on permission. **Saxo UK satisfies all four on the documents** — with the caveat that its permission is silence rather than an affirmative grant — at 0.16% round trip — an order of magnitude cheaper than IBKR at D5's ticket sizes, with no per-order minimum and no inactivity fee — and is the candidate this doc would put in front of a decision-maker first, *conditional* on two checks that cost one support email each: that an ISA sub-account is tradeable over OpenAPI, and that the ADR-0016 ETP lines are ISA-qualifying and not desk-only. **IBKR is the safer read on permission and the worse read on cost.**
4. **A venue change is not a one-line edit to ADR-0015.** Whichever way #896 goes, something else moves with it: the LSE ETP universe (#659's GBP-LSE restriction, ADR-0016's instrument list — and the ISA-eligibility question above may cut into it), the cost model (doc 53's `CostModelImpl` floors commission at **1 bp of notional** — a *rate*, so it models Saxo's structure and does **not** capture a per-order minimum like IBKR's £3), and the position sizing (**any per-order commission floor argues for fewer, larger positions**, the opposite direction from D5's fractions; at IBKR the £250 bracket is strictly worse than the £350 one, so the cost structure fights D5 directly). The £36/yr IBKR ISA fee alone is 3.6% of the book per year, which is a *sizing* problem, not a fee line.
5. **The mark-source question (#895) stays downstream.** Doc 34 recommended IBKR "LSE UK (L1)" at ~GBP 1/month for the mark. If the venue moves to IBKR the mark question collapses into it; if it does not, the two are bought separately. Decide #896 first, as #896's own acceptance criteria say.

## Unresolved / could not verify

- **Whether Trading 212 would enforce 4.2(a) / 5.1 against a single retail user trading their own account.** Not asserted here, exactly as #896 does not assert it. The clauses say what they say; enforcement posture is a question for Trading 212 or a solicitor.
- **How a lawyer parses the compound** *"Algorithmic Trading purposes **or** … commercial services"* in 4.2(a) / 5.1 / 3.7. A reading that binds the two together (i.e. prohibiting algorithmic trading *as a commercial service*) is not the natural one, but it has not been ruled out by anyone qualified.
- **Whether written consent for algorithmic trading is obtainable.** No clause creates a process. 6.3/6.6/6.7 are consent routes for other things. Only Trading 212 can answer.
- **The API documentation host moved.** Doc 34 and #896 cite `t212public-api-docs.redoc.ly`; on 2026-08-19 that host returns **302 → `/redocly-login`** and is no longer publicly readable. The live public docs are at **`https://docs.trading212.com/api`**, which is where this doc's API quotes come from. Doc 34's URL is stale, though its findings reproduce on the new host.
- **`trading212.com` marketing/fee pages return HTTP 403** to non-browser clients (`/terms-and-fees`, `/pricing`, `/trading-instruments/invest`, `/terms/cfd`, `/legal-documentation` index — all 403 on 2026-08-19), so T212's commission and FX schedule could **not** be re-verified from primary source in this pass. The legal-documentation **PDFs** fetch fine (200). T212's cost facts are therefore cited from **ADR-0015** (no commission, no SDRT on ETFs/ETCs, 0.15% FX on non-GBP, 0.30% on US stocks), not re-derived. The Key Information Document (`/legal-documentation/en/key-information-document.pdf`, 200) is CFD-specific and gives cost *categories* only — *"A currency conversion fee will be charged to your account"* — with no figures.
- **The `/cfd/` namespace probe is unauthenticated.** 401-vs-404 is good evidence the API exposes only `/equity/`, but an authenticated CFD key could route differently and this method cannot exclude that. The documented sentence (*"only for Invest and Stocks ISA account types"*) is the load-bearing source; the probe corroborates it.
- **Whether T212's Stocks ISA can actually hold every ADR-0016 LSE leveraged ETP line** is untouched here and is still #665's.

### From the alternatives survey — recorded as non-findings

- **Whether an IBKR ISA account is reachable by the TWS / Client Portal API for order entry.** No IBKR document names the two together. The linked ISA reference article (`https://ibkrguides.com/kb/article-4182.htm` → `https://www.interactivebrokers.com/lib/cstools/faq/#/content/1117410812`) is a JavaScript SPA serving an empty `<div id="app">`; four content-endpoint URL patterns returned 404. The inference (permissions ride on the username; Web API trading is *"available to all accountholders"*; the ISA page offers "APIs") is favourable but unproven.
- **Whether a Saxo ISA is tradeable over OpenAPI.** No Saxo statement found in either direction. Likewise **no Saxo OpenAPI terms-of-use document exists at any reachable URL** (`developer.saxo/openapi/learn/terms-of-use` → 404), so the General Business Terms are the only binding text quotable on API use. Saxo's HMRC ISA-manager reference was seen only in a search summary, never in a Saxo document — **do not cite it**.
- **Whether ADR-0016's LSE leveraged ETPs are ISA-qualifying at any venue.** IBKR's ISA permission profile reads *"Stock Only – No other asset types permitted"*; Saxo answers *"stocks, bonds, ETFs and funds"* and does not name ETCs/ETNs; CMC never uses the word "ETC"; XTB's instrument scanner is JS-gated. This is the single most load-bearing unknown in the survey and it is **not** resolved by choosing a venue.
- **Whether Saxo's £7/month LSE L1 entitlement is delivered over OpenAPI.** Two Saxo statements are in tension (the developer FAQ names only FX/bonds/BATS as default streaming data; the client subscription plus *"SaxoTraderGO is powered by OpenAPI"* implies pass-through). Bears directly on #895.
- **SDRT on LSE-listed, non-UK-domiciled ETFs/ETCs.** ADR-0015 asserts no SDRT on GBP LSE ETFs/ETCs, and brokers' own pages say only *"0.5% on purchases of UK shares"* without addressing ETFs. No primary source confirming the ETF exemption was reached in this pass. If it applied it would add **£1.75 to a £350 buy** — 50 bps on every entry, which is not a rounding error against doc 52's bars.
- **IG's minimum deal size for share dealing** is not published on any page reached; the relevant help page renders empty without JavaScript. Do not read that silence as "no minimum".
- **CMC's own FRN is internally inconsistent** in one document (170627 in the header vs 173730 in clause 2.1 of the same Spectre Spreadbet ToB). Not adjudicated.
- **Tastytrade's UK-resident eligibility** could not be established — the eligible-countries article is a Salesforce SPA returning a loading shell. Moot: no UK entity, no ISA, no LSE.
- **The FCA Financial Services Register could not be queried** — `register.fca.org.uk` serves a Lightning SPA shell to non-browser clients and its `/services/V0.1/Firm/<FRN>` endpoint returns 403. **Every FRN in this doc is cited to the firm's own page or terms PDF, not to the Register.** Register-side confirmation is outstanding.
- **Spreads — the dominant cost term for the CFD venues — are login-gated everywhere.** No CFD firm publishes an LSE ETF/ETP spread table, so those round-trip figures are commission-only and understate cost.
