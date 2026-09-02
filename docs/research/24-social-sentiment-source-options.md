# Social Sentiment Sources — StockTwits and Reddit, Primary-Source Verification (2026-09-01)

Resolves [StockTwits and Reddit APIs in 2026: access tier, cost, rate limits,
licensing](https://github.com/dd-jp/samurai-trading-system/issues/974), child of [Wayfinder: real X
retrieval for sentiment — what is the retrieval subject, and does the lens justify an ADR-0009
exception?](https://github.com/dd-jp/samurai-trading-system/issues/522).

**Why this document exists.** [#961](https://github.com/dd-jp/samurai-trading-system/issues/961)
established that the system needs the **social/crowd sentiment lens** — `CONTEXT.md`'s recorded
Stage 0 edge thesis names it as one of the parallel lenses the debate-as-edge mechanism depends on.
[#969](https://github.com/dd-jp/samurai-trading-system/issues/969) then asked whether to grant an
**ADR-0009 exception** for xAI's `x_search`, the only path to real X-crowd sentiment
([doc 21](21-mi-ingestion-architecture.md), ~$10–15/14d, login-walled citations). David's ruling on
grilling #969: **research a non-X social source first.** If StockTwits or Reddit can serve the lens,
no ADR-0009 exception is needed at all — data-vendor keys sit outside its scope — and the provenance
is publicly verifiable rather than login-walled.

Everything below is quoted from the vendor's own terms, retrieved 2026-09-01. Where a document could
not be retrieved it is marked **UNVERIFIED** rather than inferred — the same discipline as
[doc 22](22-mi-source-licensing.md), and for the same reason: this repo has twice been saved by
reading a clause instead of assuming it ([#557](https://github.com/dd-jp/samurai-trading-system/issues/557)
killed Massive news on a derivative-works clause naming "investment strategy";
[#896](https://github.com/dd-jp/samurai-trading-system/issues/896) disqualified Trading 212 as a
venue on its own algorithmic-trading prohibition).

---

## Verdict

| Source | Verdict | Binding reason |
|---|---|---|
| **StockTwits** | **UNUSABLE** | API registrations are closed to new applicants, and the Terms permit automated extraction *only* through an approved API/developer offering — the one lawful channel is the one that is shut. |
| **Reddit** | **USABLE-WITH-CAVEATS, gated** | Free tier is real and the rate limit is irrelevant at our volume, but access needs a discretionary approval ticket that must disclose the trading use, and the retention rules are incompatible with the currently-specified "archive bodies to SQLite and replay" design. |

**Neither source removes the need for the xAI/ADR-0009 exception on today's evidence.** The decision
#969 faces is narrower than "StockTwits vs Reddit vs xAI" — see §4.

---

## 1. StockTwits — UNUSABLE

### 1.1 Access is closed

`https://api.stocktwits.com/developers`, retrieved 2026-09-01, in full:

> "Hello and thank you so much for your interest in our APIs!
> In an effort to continually improve our offerings and value to the community, we are currently
> reviewing all of our APIs, documentation and terms.
> We unfortunately won't be accepting new registrations until we have finished our review and made
> the necessary improvements and upgrades.
> For any questions please email developers@stocktwits.com."

The notice carries no date. The docs path (`/developers/docs`) returns 403 to non-browser clients, so
**cost, tier and rate limits are UNVERIFIED** — no third-party numbers are imported here.

A "StockTwits API" listing exists on RapidAPI. A third-party marketplace **cannot grant rights
StockTwits has not granted**; it is not a legitimate route.

### 1.2 The operative clause

`https://stocktwits.com/about/legal/terms`, **Last Revised July 10, 2026**, §5 "No Unauthorized
Managed, Automated, or Scraping Access":

> "You may not share your account credentials, provide managed access to your account, or use the
> Service through an unauthorized third-party posting service, scraping service, automation service,
> signal service, copy-trading service, account-management service, or similar arrangement.
>
> You may not scrape, harvest, mirror, frame, deep-link to, data-mine, or otherwise extract data or
> content from the Service by automated means **except as expressly authorized by us in writing or
> through an approved API, widget, developer offering, or other product rule.**"

**Read this precisely, because the obvious over-read is wrong.** The first paragraph's "signal
service, copy-trading service" is a list of third-party intermediaries you may not access the Service
*through* — it is **not** a prohibition on the operator's own system being a signal generator. The
**second** paragraph is what binds: automated extraction requires written authorization or an
approved developer offering, and registrations for that offering are closed.

**There is no clause barring use of StockTwits data to inform your own investment decisions, and no
commercial-use definition in these Terms.** §14 ("No Investment, Legal, or Tax Advice") is a
disclaimer, not a use restriction. §7 expressly contemplates StockTwits itself licensing derived
products "to third parties, including financial institutions and investment firms, for research,
analysis, benchmarking" — sentiment-for-finance is a product they sell, not a prohibited purpose.
**The blocker is access authorization, not purpose.**

Also binding if a workaround were attempted: §6 forbids "circumvent our technical measures, rate
limits, access controls, or security protections", and §12 forbids creating derivative works "except
as expressly permitted by these Terms". §1 adds that API-specific terms would **control** over these
where they conflict — and those are **UNVERIFIED**, being unreachable.

### 1.3 Empirical probe (dated observation, not policy)

`GET https://api.stocktwits.com/api/2/streams/symbol/NVDA.json` on 2026-09-01 returned **HTTP 403 with
a Cloudflare interstitial** to a plain HTTP client. The legacy unauthenticated symbol-stream endpoint
is not usable from a script today, and defeating the challenge would independently breach §6 and §5.

**UNVERIFIED:** whether StockTwits permalinks render logged-out; per-symbol message volume.

**Revisit only if** `api.stocktwits.com/developers` reopens, or an email to developers@stocktwits.com
yields written authorization.

---

## 2. Reddit — USABLE-WITH-CAVEATS

### 2.1 Access: free tier real, approval mandatory

[Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki):

> "You can use the Reddit Data API, subject to our Responsible Builder Policy, Developer Terms and
> Data API Terms. To request, please contact us here. […] Clients must authenticate with a registered
> OAuth token. We can and will freely throttle or block unidentified Data API users."

[Responsible Builder Policy](https://support.reddithelp.com/hc/articles/42728983564564):

> "**Approval is required:** You must request access and get explicit approval before accessing any
> Reddit data through our API […]
> **Be transparent:** You must not misrepresent or mask how or why you are accessing Reddit data."

Self-service signup is gone. **UNVERIFIED:** approval turnaround and odds for a solo trading use case
— published nowhere primary.

### 2.2 Cost

[Developer Platform & Accessing Reddit Data](https://support.reddithelp.com/hc/en-us/articles/14945211791892):

> "Reddit offers both free and paid access. Whether your use will require paid access depends on how
> you access and use the data. […] select developers who require broader access to Reddit data may be
> charged fees to lift those limits."

Data API Terms §3.1: "Reddit reserves the right to charge fees […] rates to be determined at Reddit's
sole discretion."

**There is no published rate card.** The widely-circulated "$0.24 per 1,000 calls" / "$12,000 per
month" figures appear only in third-party blogs and are **UNVERIFIED** — do not cite them. Approved
as non-commercial, the tier is **$0/month**; routed to commercial, it is a negotiated contract, which
is almost certainly disqualifying for a £1,000 book.

### 2.3 Rate limits — not binding

Data API Wiki: "The limit is: **100 queries per minute (QPM) per OAuth client id** […] an average over
a time window (currently 10 minutes) to support bursting requests." Traffic not using OAuth "will be
blocked". A `<platform>:<app ID>:<version> (by /u/<username>)` User-Agent is mandatory — "NEVER lie
about your User-Agent."

100 QPM = 144,000 requests/day. Our worst case (a few hundred/day across ~26 tickers) is **~0.2% of
the free allowance**. Non-issue.

### 2.4 Licensing

**(a) Automated/algorithmic access — permitted.** Reddit's model *is* apps and bots; the Responsible
Builder Policy applies "to all users and developers who use or develop apps –including bots, AI
agents, or non-human operated accounts–". **No clause anywhere prohibits trading use as such.** There
is no analogue to Trading 212's algo-trading prohibition.

**(b) Commercial use — a genuine, unresolved tension.** Two primary documents pull opposite ways, and
this document does not resolve it, because Reddit resolves it at App Review.

[Developer Terms](https://www.redditinc.com/policies/developer-terms) (Last Revised March 24, 2026)
§4.1 "Commercial Use Restrictions":

> "Unless expressly permitted […] you will not […]
> * access or use any of the Reddit Services and Data by or on behalf of a business or as part of a
>   service or product that is monetized; or
> * **sell, lease, sublicense, monetize, or otherwise obtain or derive revenues of any kind from any
>   portion of Reddit Services and Data, whether directly or indirectly, including from any data
>   derived from the foregoing.**"

That bolded bullet is this repo's prior art staring back — trading profit is arguably "revenues […]
derived indirectly […] from data derived from" Reddit data.

*Against it*, the help article Reddit's own §4.1 cites for "examples of restricted commercial use"
defines the term narrowly — "any use of our services by a business or on behalf of a business or as
part of a monetized product or service" — and **every one of its nine examples is a product sold to
third parties** (ads, paywalls, subscriptions, sponsorships, data-for-fees, selling model access). A
single operator trading their own capital on a localhost-only dashboard sells nothing and is not a
business. The article's closing sentence hands the call to Reddit: "The information you provide about
your use case and App during Reddit's App Review will determine your eligibility and approval for
commercial (or non-commercial) use."

Note Data API Terms §3.2 is narrower still, targeting revenue from *the APIs or access thereto*, not
from insights.

**The crux: there is no compliant way to route around this.** Because the Responsible Builder Policy
requires "You must not misrepresent or mask how or why you are accessing Reddit data" (and Developer
Terms §4.2 repeats it), the access ticket **must disclose that the data feeds a live-money trading
system**. That disclosure is what selects between the two readings.

**(c) Derivative works, redistribution, AI.** Data API Terms §2.4 grants a licence "to copy and
display the User Content […] solely as necessary to develop, deploy, distribute, and run your App to
your App Users. **You may not modify the User Content except to format it for such display.**"
Developer Terms §4.2 forbids access "**to train** large language, artificial intelligence, or other
algorithmic models […] without our permission", and the help article is blunt: "**Can I use content
on Reddit to build a large language / AI model?** No."

**Every AI clause is scoped to _training_.** Passing a post to an LLM at inference time to score
sentiment is not training, and **no primary clause prohibiting LLM inference over Reddit content was
found**. But §2.4's "may not modify […] except to format it for display" alongside §4.2's flat "create
derivative works of […] the Reddit Services and Data" is broad enough that a **persistently stored
computed sentiment score sits in grey territory.** Flagged, not resolved.

Redistribution is a non-issue for this profile: display is to "your App Users", and a localhost-only
single-operator dashboard has exactly one. The absolute rule "You cannot display Reddit content and
run advertisements within your app" is irrelevant here (no ads).

**(d) Retention — the blocker, and it needs no interpretation.**

Data API Wiki:

> "You must remove any user content in your possession that has been deleted from Reddit. […]
> * To best comply with this policy, we strongly recommend routinely deleting any stored user data
>   and content **within 48 hours**.
> * **Note that retention of content and data that has been deleted—even if disassociated,
>   de-identified or anonymized—is a violation of our terms and policies.**"

Data API Terms §6 (Termination): on termination you must "delete any cached or stored User Content and
Materials […] **This includes any data or models that were derived from User Content and Materials.**"

**"Archive message bodies to local SQLite indefinitely and replay them in backtests" directly violates
this.** Worse, §6 means that if access is ever revoked, the historical corpus *and derived data* must
be destroyed — which retroactively voids backtest reproducibility, the one property
[doc 13](13-stage2-proxy-verdict.md)'s PBO/DSR accounting cannot give up.

**The mitigation that makes "usable-with-caveats" reachable:** persist only the **derived sentiment
score plus the canonical permalink** — never title, body or author — and re-fetch at replay time,
honouring deletions. **UNVERIFIED:** whether a stored permalink + score itself counts as "related
content" that must be purged on deletion; the Wiki's duty reaches "all content related to the post
and/or comment (e.g., title, body, embedded URLs, etc.)" and no primary text settles it.

**One further flag.** The Responsible Builder Policy states: "**Any research that uses Reddit data
collected outside of the RFR Program is in violation of this policy**", and the help article says the
Reddit For Researchers programme is "the only official and authorized avenue for performing research
using Reddit data." Read in context this means *academic study*, not strategy backtesting — **but that
reading is inference, not a primary-source statement**, and an access ticket describing "backtesting"
as research could plausibly be bounced to RFR, whose terms are non-commercial-only.

### 2.5 Coverage

**No primary source publishes per-subreddit or per-ticker message volume**, and no blog figures are
imported. Qualitatively: r/wallstreetbets, r/stocks, r/investing and r/options are the relevant
venues, and the known skew toward high-beta and meme names applies. For the large caps in scope
(NVDA, TSLA, AAPL, SPY, QQQ) coverage is plausibly adequate; the tail of the ~26
`screening_instrument` values is likely sparse. **Measure empirically during a trial — do not assume.**

### 2.6 Provenance and replayability

Every post and comment has a stable public permalink (`reddit.com/r/<sub>/comments/<id>/...`), with
`.json` appended for machine-readable form, viewable without a login in a browser. **This beats
xAI `x_search`'s login-walled citations outright on provenance.**

**Caveat from direct probing 2026-09-01:** `reddit.com/wiki/api` and `old.reddit.com/wiki/api` both
returned JavaScript shells to non-browser clients, so archived citations are verifiable **by a human
in a browser** but not reliably re-fetchable **by a script** without OAuth. Deleted items 404 — which
is exactly the mechanism the retention rules rely on, and exactly what makes an
archived-citation-plus-refetch design lossy over time.

---

## 3. Other candidates, briefly

**Bluesky / AT Protocol** — **SUPERSEDED 2026-09-02 by [`25-bluesky-social-sentiment-source.md`](25-bluesky-social-sentiment-source.md) (#1041). Verdict: UNUSABLE, on volume.** Read doc 25 rather than this paragraph; it is kept only to show what was believed before the measurement.

Two corrections to what this paragraph asserted:

- **The 403 was not the host refusing anonymous traffic.** `getProfile`, `searchActors` and `getAuthorFeed` all return 200 unauthenticated on `public.api.bsky.app`. But `searchPosts` *specifically* 403s at the CDN edge there, so this paragraph's claim that the public AppView "exposes `app.bsky.feed.searchPosts` without authentication" is **wrong for that host**. It is reachable unauthenticated on `api.bsky.app`, under an undocumented ~3-call burst throttle. Everything else here — open firehose, no-login permalinks, no approval gate, no fee — held up, and the licensing review found **no** anti-automation, anti-commercial, or indirect-revenue clause, and no Reddit-style retention purge.
- **The suspected weakness was the real one, and it is now measured rather than suspected.** A 10-minute unauthenticated Jetstream sample on 2026-09-02 (25,269 posts, the whole network) returned **zero cashtag mentions of any of the 26 pool tickers**, and of 116 bare-word hits only four were finance-worded — those four being an Amazon affiliate-link post and tokenized-stock pump bots. So the little ticker-adjacent content that exists is automated promotion, which would poison the lens rather than thin it.

**Finance-specific sentiment vendors** (Tiingo/Finnhub-style resellers of social sentiment scores)
were not researched here, but are worth a look for one structural reason: they move the licensing
question onto a **vendor contract that explicitly permits investment use**, which is likely a cleaner
path than any raw social API. Alpaca's news feed, already in the stack, is Benzinga newswire — not
social — so it does not serve this lens.

---

## 4. What this means for #969

**On today's evidence, neither source is a clean drop-in that removes the need for the xAI exception.**
StockTwits cannot be adopted at any price while registration is closed. Reddit is available only
behind a discretionary approval, under retention terms incompatible with the archive design as
currently specified.

So the decision #969 faces is narrower than the three-way choice it was framed as:

1. **Submit the Reddit access ticket**, describing the system honestly — single operator, own capital,
   localhost display, a few hundred requests/day, sentiment scoring only, no redistribution, no model
   training. It is free, reversible, and converts the largest unknown into a fact. **Nothing else in
   this report can be resolved without it.**
2. **Independently decide whether a score-plus-permalink archive is acceptable** for backtest replay.
   If backtests require verbatim message bodies, Reddit is **unusable regardless of approval**, and
   that — not licensing — is the deciding constraint.
3. **Only if (1) is rejected or (2) fails** does the xAI/ADR-0009 exception become the remaining
   option. Note that xAI's login-walled citations **lose to Reddit's public permalinks on
   provenance**, so the exception should not be granted on convenience grounds while (1) is untested.

## Unverified items, stated as gaps rather than inferences

- StockTwits pricing, rate limits, and API-specific terms — developer docs unreachable (403).
- Whether StockTwits permalinks render logged-out.
- Reddit's commercial rate card — no primary source for the widely-quoted figures.
- Reddit approval turnaround and odds for this use case.
- Per-symbol message volume for either source.
- Whether a stored permalink + score satisfies Reddit's deletion duty.
- Whether strategy backtesting would be classed as "research" and routed to RFR.
- ~~Bluesky public API open access (403 from the research environment on 2026-09-01).~~ **RESOLVED 2026-09-02 by doc 25 (#1041)** — the host serves anonymous reads; `searchPosts` alone is edge-blocked on `public.api.bsky.app` and throttled on `api.bsky.app`. Bluesky is nonetheless ruled out on measured finance-chatter volume, not on access.
