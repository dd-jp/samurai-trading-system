# MI Source Licensing — Primary-Source Verification (2026-08-07)

Resolves [MI rework: licensing verification — Alpaca/Massive display clauses, RSS posture, GDELT
attribution](https://github.com/dd-jp/samurai-trading-system/issues/557), child of [Wayfinder: MI
rework — deterministic news ingestion, decoupled from LLM scoring (doc
14)](https://github.com/dd-jp/samurai-trading-system/issues/552).

Doc 14 §3 and §7.4 left licensing as the open item before news content reaches the dashboard: *"the
endpoint docs are silent; the blog's 'build custom news widgets' intent is suggestive, not
contractual."* This document reads the contracts.

Everything below is quoted from the vendor's own terms, retrieved 2026-08-07. Where a document could
not be retrieved it is marked **UNVERIFIED** rather than inferred — inference from marketing copy is
the exact failure doc 21 named.

---

## 1. The frame that decides most of it

Two facts about Samurai change which clause bites, and both were verified in-repo rather than
assumed:

1. **The dashboard is a single-operator console on localhost.** `docs/research/40-dashboard-framework-and-hosting.md`
   §2.5: *"a single-operator console on localhost: no SEO, no public traffic, no multi-tenant auth,
   no user-generated content"*. ADR-0010 §4 adds that the built page reaches no host but its own
   origin. Exposure, if any, is planned behind Cloudflare Zero Trust or Tailscale — still no public
   surface.
2. **There is one user, trading his own capital.** No third-party subscribers, no signal resale, no
   managed money, no advertising.

So for every source below, **redistribution is not in play** — nothing leaves the machine. The live
question is narrower and sharper:

> Is a private, single-user, live-money trading system **"personal and non-commercial"**, or is it
> **"commercial"**?

That single question decides Alpaca and the Guardian, and it is not a question a research ticket can
answer on David's behalf. It is surfaced in §7.

A second question, mostly independent of the first, decides Massive:

> Does a **derived-data clause** that names "investment strategy" bar computing a trading signal from
> the vendor's content?

---

## 2. Alpaca News — **KEEP** (permitted on the current posture; one clause to respect)

The governing document is [Alpaca Terms and
Conditions](https://files.alpaca.markets/disclosures/library/TermsAndConditions.pdf), not the
endpoint docs. It is not silent — doc 21 looked in the wrong place.

**News is explicitly inside the licensed "Content".** The T&C define Content to include *"(2) general
news and information, commentary, research reports, educational material and information and data
concerning the financial markets, securities and other subjects"*. Benzinga is a *"Third-Party
Provider"* and its output is *"Third Party Content"* under the same agreement. There is no separate
Benzinga display agreement to hunt for; this is it.

**The one binding restriction is scope of use, not display:**

> "Personal and Non-Commercial Usage — Other than as set forth herein, you agree to use the Services
> and Content solely for your own personal and non-commercial purposes. Should you wish to use the
> Services and Content for any other purposes, including without limitation commercial usage, or
> making the Services and Content available to others through your own application (a "User
> Application"), you shall provide Alpaca with 30 days advance written notice prior to making such
> User Application available to others."

Three things follow:

- **There is no display-only clause and no redistribution prohibition** on Content in this agreement.
  Displaying retrieved headlines on the localhost console is not restricted by anything in it. The
  open item doc 21 flagged resolves in our favour.
- **There is no prohibition on non-display / analytical use.** Unlike the exchange-data agreements
  (§3), the Alpaca T&C contains no derived-data clause. Feeding article text to the scorer is not
  addressed, therefore not forbidden.
- **The trigger for the 30-day notice is making the Content available _to others_.** On a
  single-operator console there are no others. If the dashboard is ever exposed to another person, or
  the system ever serves anyone but David, that notice obligation activates — and so does the
  "commercial usage" question in §7.

Note the exchange-data agreements linked from Alpaca's disclosures page ([NASDAQ OMX Global Subscriber
Agreement](https://files.alpaca.markets/disclosures/library/NASDAQ+OMX+Global+Subscriber+Agreement.pdf),
[NYSE Market Data Display Services
Agreement](https://files.alpaca.markets/disclosures/library/NYSE+Market+Data+Display+Services+Agreement.pdf))
bind the **Pro** real-time market-data plan, not the News API. We are on the free plan and consume
news, so they do not attach here.

**Doc 14 risk rating LOW-MED → revised LOW**, conditional on the console staying single-user.

**Beta terms: UNVERIFIED.** `docs.alpaca.markets/docs/news-api` returned 404 on the path tried, so the
current beta language was not read from the primary source. Alpaca's own launch announcement
describes the News API as *"a limited-time beta"* available free with rate limits set by the market
data plan (200 calls/min on Free). Nothing in the T&C conditions Content use on a service being
generally available. The residual risk is commercial, not legal: **the free tier could end.** That is
a supply risk for #553's fetcher-set decision, not a licensing blocker.

---

## 3. Massive (formerly Polygon.io) — **KILL for news**

`polygon.io/terms` now 301s to `massive.com/terms`; the company has rebranded to **Massive**. Terms
split into Website / Individuals / Businesses, plus a separate Market Data ToS.

**First, a scope correction that matters.** The Market Data ToS is the harshest document —

> "any and all Market Data is strictly for display use only"

> "you may not use Market Data for non-display use or to create derivative works (including, without
> limitation, any index, indicative value, net asset value, investment product, financial contract…
> settlement value or investment strategy) based on the Market Data"

— but **"Market Data" is defined narrowly as exchange data**: *"(a) last sale information and
quotation information relating to securities that are admitted to dealings on the New York Stock
Exchange…"*, with Third Party Providers named as OPRA, Nasdaq, CME and NYSE. **Benzinga and news
organisations appear nowhere in it.** So `/v2/reference/news` is *not* caught by the display-only
clause. Doc 14's worry about a news display clause is misdirected.

**The clause that does bite is broader and appears in the general terms.** The Businesses ToS grants
a right to *"access, receive, process, transmit, store, and use the Information available via the
Services solely for its use in websites or software applications owned or licensed by Customer"* —
display in our own app is fine — but then:

> "Customer will not… use the Information to create derivative works (including, without limitation,
> any index, indicative value, net asset value, investment product, financial contract… settlement
> value or investment strategy) based on the Information unless licensed to do so."

Here the object is **"the Information"** — everything served by the Services, news included — not the
narrow "Market Data". And the enumerated list names **"investment strategy"** outright. A sentiment
score computed from Massive news and fed to a trading decision is an investment strategy derived from
the Information.

The Individuals ToS is no easier: the grant is *"solely for your own personal, non-commercial, and
non-business purposes"*, and separately *"you may not use the Market Data for any business or
commercial purpose, and you may not use the Market Data to build an application intended for use by
end users other than you"*.

**Assessment.** The derivative-works enumeration is standard exchange derived-data boilerplate, and
it is genuinely arguable that Massive does not intend it to stop a private individual computing a
signal for his own account. But we would be relying on that argument, not on the text — and unlike
Alpaca, there is no reading of the text that plainly permits what we want to do. Doc 14 already has
Massive as **fallback only**, behind Alpaca, for an unrelated reason (hourly updates, staleness).

**Recommendation: drop Massive news from the MI fetcher set entirely.** It costs nothing — Alpaca
covers the same tickers with better freshness, stable int64 IDs and 2015 history — and it removes the
one news source whose own terms name our use case as prohibited. **Doc 14 risk rating MED → HIGH.**

### ⚠️ Collateral finding, outside this ticket's scope

That same derivative-works clause attaches to **"the Information"**, which includes the **OHLCV
aggregates Samurai already pulls from Polygon/Massive** as a bar-data fallback. If the clause means
what it says, the exposure is not limited to news that was never built — it touches data already in
use on a live-money path.

This is flagged, deliberately not resolved: it sits outside the MI map's destination, and the call
(re-read in full / seek written clarification from Massive / drop Massive bars for the
Alpaca+Coinbase+Bitstamp stack already proven at £0 in `free-ohlcv-*`) is David's. It is recorded here
so it does not evaporate with this session.

### Collateral finding RESOLVED — [#612](https://github.com/dd-jp/samurai-trading-system/issues/612), 2026-08-17

The ticket allowed for a no-op close *"if Massive is genuinely not in the backfill path any more"*.
**It is not that clean.** Massive is off the live feed entirely, but it is still the **default**
source of Stage 2's strategy verdicts.

**Clause re-verified against the primary source**, not from the quote above. `polygon.io/terms` now
resolves to `massive.com/terms`, which splits into three documents. Two of them matter and they do
**not** say the same thing:

| Document | Last updated (read 2026-08-17) | Derivative-works object | Bites? |
| --- | --- | --- | --- |
| Businesses ToS §6.1(j) | 2025-09-02 | **"the Information"** — everything the Services serve, aggregates included; enumeration names *"investment strategy"* | **Yes**, on plain wording |
| Individuals ToS | 2025-07-18 | *"the **Services** or the technology underlying the Services"* — the software, **not** the data | **No** — but the grant is *"solely for your own personal, non-commercial, and non-business purposes"* |

§6.1(j) is unchanged from the §3 quote above and the licence grant that precedes it is narrower than
recorded: *"solely for Customer's internal purposes"* (§2.1), where the earlier reading had the
websites/applications wording. **The Individuals ToS is the materially easier document, and it is
plausibly the one that binds us** — the key is a free personal registration, not a business account,
and "investment strategy" appears there only inside a no-advice disclaimer, never as a prohibition.
That reading is not free: it depends on £1,500 of own-account trading counting as *personal,
non-commercial and non-business*, which is arguable and unlitigated here. Not legal advice.

**Where Massive bars actually reach, in code.** Four call sites, **all under `server/tools/`**:

| Call site | What it feeds | Live-money path? |
| --- | --- | --- |
| `server/tools/stage2-source.ts:38` | `STAGE2_SOURCE` **defaults to `'polygon'`** — every Stage 2 verdict to date was computed on Massive bars unless `free-stack` was set | Research/eval. But a Stage 2 verdict *is* an investment strategy derived from the Information — the single closest fit to §6.1(j)'s enumeration in the whole repo <!-- cite-exempt: historical — deleted in v1 teardown wave 1 (#1748); preserved at tag v1-final --> |
| `server/tools/backfill-market-data.ts:252` | equity leg of `withOhlcvFailover`: Alpaca primary → `PolygonBarsClient` fallback, persisting rows stamped `source: 'polygon'` into the shared store the runtime reads | **The one path that could put Massive bars under a trading decision** <!-- cite-exempt: historical — deleted in v1 teardown wave 1 (#1748); preserved at tag v1-final --> |
| `server/tools/run-spread-calibration.ts:258` | cost-model calibration | Research <!-- cite-exempt: historical — deleted in v1 teardown wave 1 (#1748); preserved at tag v1-final --> |
| `server/tools/run-stage2-cost-decomposition.ts:280` | cost decomposition | Research <!-- cite-exempt: historical — deleted in v1 teardown wave 1 (#1748); preserved at tag v1-final --> |

**The runtime composition root does not touch Massive.** `production.ts:547-548` builds its
`DataSource` from `buildAlpacaDataSource` and `MarketDataServiceImpl` gets nothing else; there is no
Polygon branch on the tick path in paper or live. Empirically confirmed against the paper store:
`select source, count(*) from bars` returns **`alpaca|209` and nothing else** — the failover leg has
never fired, so no Massive-derived bar has ever priced a decision.

**Assessment.** Exposure on the live-money path is **near-zero today but not structurally closed** —
it is one Alpaca outage away from being real, because that is exactly when the fallback fires.
Exposure on the *research* path is live right now and is the larger surface: the Stage 2 KILL, the
PBO/DSR numbers and the cost decomposition were all computed off Massive aggregates.

**Recommendations for David — the call remains his.**

1. **Backfill (do this one).** Drop `PolygonBarsClient` from the equity failover chain, or leave it
   unconstructable by keeping `POLYGON_API_KEY` out of the runtime environment. It has never served a
   bar, so removing it costs nothing measured, and it is the only route from §6.1(j) to a live order.
   Note the trade-off honestly: equities then have **no** OHLCV fallback, since Coinbase/Bitstamp
   cover crypto only.
2. **Stage 2 default — do not flip it.** `stage2-source.ts`'s module doc keeps `'polygon'` default so
   prior verdicts stay reproducible with no environment change, and that reason still holds. If the
   strict Businesses reading is adopted, the right move is to **re-run the standing verdicts under
   `STAGE2_SOURCE=free-stack`** (ten years vs two, £0, keys already held) and cite those, rather than
   silently changing what every existing invocation measures.
3. **Do not seek written clarification from Massive.** Asking a vendor whether its boilerplate bars a
   retail account invites a written "yes" that forecloses the Individuals reading, on a dependency
   the project can replace at £0.

---

## 4. RSS fleet — posture confirmed as **gray, and less gray than hoped**

Doc 14 §5 recorded the stance as *"ToS gray: syndication feeds, internal non-redistributed signal
extraction is ecosystem norm but not affirmatively licensed"*, and singled out the Guardian. That
reading is confirmed, and the Guardian case is now worse than "gray".

### Guardian — **KILL**

The Guardian has **affirmatively priced our exact use case.** Its Open Platform sells two key tiers.
The free Developer key is *"for any non-commercial usage of the content, such as student
dissertations, hackathons, nonprofit app developers"*. The Commercial key is

> "for all use cases by commercial enterprises and developers wishing to utilise Guardian journalism
> in any manner. In addition to app development and publishing content on third party sites, use
> cases may also include but are not limited to: training models for generative artificial
> intelligence services, text and data mining solutions, **sentiment analysis where content is not
> reproduced**, and any and all products and services derived or sourced from Guardian content."

"Sentiment analysis where content is not reproduced" is a precise description of the MI layer. The
"we never display it, only analyse it" defence — the usual justification for internal signal
extraction — is the specific carve-out the Guardian names and charges for.

And the RSS route is not a way around it. The Guardian's own [feeds help
page](https://www.theguardian.com/help/feeds) states the feeds may be used *"for personal,
non-commercial purposes in accordance with our terms of service"* — the same non-commercial gate,
attached to the feeds rather than the API.

**Recommendation: drop the Guardian from the RSS fleet.** This one does not need David's ruling.
Whatever the answer to §7's commercial/non-commercial question, the Guardian is the single source
where the vendor has explicitly enumerated our use case as licensable — and its marginal signal value
is nil, since BBC / CNBC / Bloomberg / CoinDesk cover the same stories. Dropping it is close to
free; keeping it is the fleet's largest single exposure.

### BBC — **UNVERIFIED, presumed non-commercial-only**

The canonical BBC feeds terms page could not be retrieved (404 on
`bbc.co.uk/usingthebbc/terms/can-i-use-bbc-rss-feeds/`; no current replacement URL found). Secondary
sources consistently describe BBC RSS as personal-use-only with a prescribed attribution, later
expanded to permit some third-party reuse. **Recorded as unverified rather than inferred.** If the
RSS fleet ships (it is v1.2+ at the earliest per doc 21's ordering), this must be read before BBC goes
in.

### Bloomberg, CNBC, CoinDesk, CoinTelegraph, MarketWatch, Fed, SEC — **not individually read**

Out of time-box for this ticket and not yet needed: doc 21's recommended ordering puts the RSS fleet
behind Alpaca News and GDELT, so no RSS terms gate v1. Fed and SEC are US government works and carry
no such restriction. The rest inherit the same gray posture and the same §7 question.

**Net effect on the fleet:** the RSS layer's licensing posture is materially weaker than the
structured sources', and it is also the layer with **zero backfill** (doc 21: its backtest value
starts only at go-live). Those two facts point the same way — the argument for shipping RSS early was
never strong, and licensing does not strengthen it.

---

## 5. GDELT — **KEEP, cleanest licence in the set**

Verified against [gdeltproject.org/about.html](https://www.gdeltproject.org/about.html):

> "all datasets released by the GDELT Project are available for unlimited and unrestricted use for
> any academic, commercial, or governmental use of any kind without fee"

> "You may redistribute, rehost, republish, and mirror any of the GDELT datasets in any form"

> "any use or redistribution of the data must include a citation to the GDELT Project and a link to
> this website (https://www.gdeltproject.org/)"

Commercial use is explicit — GDELT is the only source in the set that does not raise §7's question at
all. Redistribution is permitted, so even a future public dashboard is unproblematic.

**One obligation, and it is concrete: attribution.** Citation plus a link to
`https://www.gdeltproject.org/`. Where it lands:

1. **The dashboard**, on any view rendering GDELT-derived items — a footer line is sufficient, and it
   is cheap to add while the panel is being built rather than retrofitted.
2. **`docs/`**, in the MI spec and the adoption ADR.

This should be written into the GDELT fetcher's acceptance criteria at implementation time, not left
as a docs chore.

---

## 6. Summary table

| Source | Layer | Verdict | Governing text | Doc 14 rating → revised |
|---|---|---|---|---|
| **GDELT** | macro | **KEEP** — cleanest | Unlimited commercial use; redistribution allowed; **citation + link required** | (clean) → **clean, one obligation** |
| **Alpaca News** | ticker | **KEEP** | Personal/non-commercial clause; **no display or derived-data restriction**; 30-day notice only if made available to others | LOW-MED → **LOW** |
| **Calendar spine** (BLS/BEA/FOMC/ALFRED) | macro | **KEEP** | US government works | (unrated) → **clean** |
| **Polymarket** | macro | not re-read | own lineage (#481) | — |
| **Massive** (ex-Polygon) news | fallback | **KILL** | Derivative-works clause over "the Information" names "investment strategy" | MED → **HIGH** |
| **Guardian** (RSS) | fast headlines | **KILL** | Commercial tier explicitly prices "sentiment analysis where content is not reproduced"; feeds are personal/non-commercial | gray → **priced against us** |
| **BBC** (RSS) | fast headlines | **UNVERIFIED** | terms page 404; presumed non-commercial-only | gray → **unverified, read before use** |
| Other RSS | fast headlines | not read | not needed for v1 | gray → gray |

---

## 7. The one decision this forces — for David

Research cannot settle this, and it should not be settled inside an implementation PR:

> **Does Samurai count as "commercial" use?**

It is a private, single-user system with no customers, no revenue and no redistribution — which reads
as personal. It also trades real money for profit — which is how a vendor's counsel would read
"commercial". Alpaca and the Guardian both gate on exactly this word.

Why it matters concretely:

- **Answer "personal / non-commercial":** Alpaca News is clean today, and the fleet's gray sources are
  defensible. This is the reading the recommendations above assume.
- **Answer "commercial":** Alpaca's clause requires **30 days advance written notice** — and that is a
  notice obligation, not a licence fee, so it is cheap to discharge and worth doing pre-emptively if
  there is any doubt. The Guardian would require a paid key (already dropped in §4). Nothing else in
  the v1 set changes, because GDELT permits commercial use outright.

The asymmetry is the useful part: **on either answer, v1 = Alpaca News + GDELT is viable.** No
licensing finding blocks the recommended v1. Only the RSS layer and Massive are affected, and both are
now recommended out.

**Two follow-ups, neither blocking v1:**

1. Ruling on the commercial question, and if in doubt, sending Alpaca the 30-day notice.
2. The Massive derived-data exposure on **OHLCV bars already in use** (§3) — the one finding here that
   touches shipped code rather than planned code.

---

## 8. What this changes for the fetcher-set decision (#553)

Doc 14's recommendation was v1 = Alpaca News, v1.1 = GDELT, calendar + RSS behind them. Licensing
**does not disturb the top of that order and sharpens the bottom**:

- **Alpaca News as v1 survives contact with the contract** — and the specific fear that motivated this
  ticket (a Benzinga display clause blocking the dashboard) turns out not to exist.
- **GDELT is the least encumbered source in the set**, which is a mild argument for pulling it forward
  rather than letting it slip.
- **The RSS fleet should move further back, not forward.** The "ship it early or lose history forever"
  argument is real but now competes with the fleet being the weakest-licensed layer and the one
  needing a per-source read before each addition. Guardian is out; BBC is unverified.
- **Massive drops out of the fallback slot** for news.
