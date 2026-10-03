# Bluesky / AT Protocol as a Social Sentiment Source — Primary-Source Verification (2026-09-02)

Companion to [doc 24](24-social-sentiment-source-options.md), which covered the same question for
StockTwits and Reddit. Same wayfinder lineage: child of [Wayfinder: real X retrieval for sentiment —
what is the retrieval subject, and does the lens justify an ADR-0009
exception?](https://github.com/dd-jp/samurai-trading-system/issues/522), feeding the decision in
[#969](https://github.com/dd-jp/samurai-trading-system/issues/969).

**Why this document exists.** Doc 24 §3 named Bluesky "the most credible remaining option" but left
its central claim **UNVERIFIED** — a probe of `public.api.bsky.app` returned 403 from the research
environment on 2026-09-01, so "the public AppView exposes `app.bsky.feed.searchPosts` without
authentication" was an assertion, not a fact. This document tests it and reads the actual terms.

**Consumer profile assumed throughout** (it is what the licensing answers are scoped to): a single
individual running a personal automated trading assistant on their own laptop, trading ~£1,000 of
their own capital, reading public posts about ~26 US stock tickers, a few hundred requests/day,
storing **only a numeric sentiment score plus the canonical post permalink** — never post text, never
author record. No redistribution, no public app, no advertising, no model training (inference-time
scoring only).

**Source discipline.** Everything below is quoted from Bluesky-owned primary sources — `bsky.network`
(the Bluesky Protocol Services docs site, which `docs.bsky.app` now 301-redirects to),
`bsky.social/about/support/*` (the legal pages), the `bluesky-social` GitHub org, and the official
blog — retrieved 2026-09-02, plus dated empirical probes run the same day and labelled as such. No
secondary write-ups are cited. Where no primary source answers a question the answer is
**"Not established from primary sources"**, per doc 24's convention and for the reason doc 24 gives.

---

## Verdict

| Dimension | Finding |
|---|---|
| **Access tier** | Genuinely open. **No registration, no approval, no API key, no discretionary gate** — nothing analogous to Reddit's approval ticket. Unauthenticated reads work today on both Bluesky-operated AppView hosts. |
| **`searchPosts` unauthenticated** | **Works, but under a tight undocumented throttle.** On `api.bsky.app` it serves ~3 calls per IP, then 403s for a cooldown of minutes, then serves again — reproducible. On `public.api.bsky.app` it 403s at the CDN edge from the first attempt. All other read endpoints stay 200 throughout. **Cause not established from primary sources.** |
| **Rate limits** | **No numeric limit published for either AppView host** — the published points/request numbers are for *record writes* and for the *PDS*. The only observed AppView limit is the undocumented ~3-call `searchPosts` burst above. |
| **Cost** | No published pricing, tier, or fee of any kind for API access. |
| **Terms** | **No anti-scraping clause, no anti-automation clause, no commercial-use restriction, and nothing analogous to Reddit Developer Terms §4.1's "indirectly derive revenue" bar. No separate developer agreement to sign.** |
| **Retention** | **No Reddit-style purge rule exists.** Nothing requires deleting derived data, and nothing says retention of de-identified derived data is a violation. Score+permalink is compatible in a way it was not with Reddit. |
| **Provenance** | Permalinks are **publicly resolvable with no login**, server-rendered, including the post text in `og:` meta tags. This is the decisive advantage over xAI `x_search`'s login-walled citations. |
| **Finance-chatter volume** | **ZERO, and this is disqualifying.** A 10-minute unauthenticated Jetstream sample (25,269 posts, whole network) found **0 cashtag mentions of any of the 26 pool tickers**; of 116 bare-word hits only 4 were finance-worded, and those 4 were affiliate spam and tokenized-stock pump bots. See §6. |

**Net: UNUSABLE — on volume, not on permission.**

Bluesky is the only one of the three social sources examined (StockTwits, Reddit, Bluesky) whose
licensing does *not* block this use case, and it wins outright on provenance. It fails anyway,
because §6 measured the thing that actually matters and found **nothing there** — and what little
ticker-adjacent content exists is automated promotion, which would poison the sentiment lens rather
than merely thin it. A source that is perfectly licensed and empty is still unusable; a source that
is perfectly licensed and full of pump bots is worse than unusable.

This document is therefore a **negative result**, and its licensing findings are the durable part:
if Bluesky's finance community grows later, nothing in its terms stands in the way, and §6.4 records
exactly what measurement would overturn this verdict.

---

## 1. Access tier

### 1.1 There is a public, unauthenticated read API — and it needs nothing to use

[API Hosts and Auth](https://bsky.network/docs/api-directory), under "Common Request Types":

> "**Public Bluesky app requests:** many Bluesky Lexicon endpoints are public, and do not require
> authentication. These endpoints can be made directly against the Bluesky API, preferably via the
> `https://public.api.bsky.app` hostname, which includes additional caching."

[Rate Limits](https://bsky.network/docs/rate-limits), under "Bluesky API Limits":

> "Sometimes clients connect directly to the Bluesky API, at `https://api.bsky.app` or
> `https://public.api.bsky.app`. **These direct endpoints do not support authentication.** The
> `public.api.bsky.app` endpoint is cached, and we request developers use that for 'public web' use
> cases."

**There is no registration, approval, application, or API-key process for these hosts.** No primary
Bluesky document describes one, and none of the legal pages (§4) creates one. **There is nothing
discretionary in the way Reddit's Data API approval is discretionary** — doc 24 §2.1 quotes Reddit's
Responsible Builder Policy requiring "explicit approval before accessing any Reddit data through our
API"; **Bluesky has no counterpart clause in any document read for this report.**

Authentication, where a client wants it, is a normal Bluesky account plus OAuth or an app password —
self-service, no vetting. The same [API Hosts and Auth](https://bsky.network/docs/api-directory) page:

> "There are two types of auth in the atproto network: client–server auth (where a user authenticates
> to their PDS, typically via OAuth) and service-to-service auth."

Authenticated `app.bsky.*` reads are routed through the user's PDS and proxied — "these requests all
go through the user PDS instance, and get proxied to the correct service."

### 1.2 `searchPosts` specifically — the finding that corrects doc 24

The lexicon itself flags this endpoint as the exception. From
[`lexicons/app/bsky/feed/searchPosts.json`](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/searchPosts.json)
in the `bluesky-social/atproto` repo:

> "Find posts matching search criteria, returning views of those posts. **Note that this API endpoint
> may require authentication (eg, not public) for some service providers and implementations.**"

**Empirical probe, 2026-09-02, from a GB vantage point, no credentials** (dated observation, not
policy):

| Host | Endpoint | Result |
|---|---|---|
| `public.api.bsky.app` | `app.bsky.feed.searchPosts` | **403** from the first attempt. Response headers: `server: BunnyCDN-UK1-1486`, `cdn-requestcountrycode: GB`, HTML error body. |
| `public.api.bsky.app` | `app.bsky.actor.getProfile`, `app.bsky.actor.searchActors`, `app.bsky.feed.getAuthorFeed` | **200**, valid JSON. |
| `api.bsky.app` | `app.bsky.feed.searchPosts` | **200 with full result payload** (`q=$NVDA&limit=2` returned two real posts, a `cursor`, and `hitsTotal`) — then **403**, `Server: openresty`, body `Request forbidden by administrative rules.`, for every subsequent call including fresh query strings. Access **returned on its own** a few minutes later. A deliberate re-test with eight distinct query strings back-to-back gave **`200 200 200 403 403 403 403 403`**. |
| `api.bsky.app` | `getProfile`, `searchActors`, `getAuthorFeed` | **200** throughout, including while `searchPosts` was refusing. |

**What this establishes, and what it does not.**

1. **Doc 24's §3 claim is half right and half wrong, and is now resolved.** The public AppView *is*
   open to unauthenticated reads — doc 24's blanket 403 was not the whole host being closed, because
   three other endpoints on that same host answer 200. But **`searchPosts` in particular does not
   serve unauthenticated traffic from `public.api.bsky.app`**, which is the endpoint doc 24 named.
2. **Unauthenticated `searchPosts` is reachable on `api.bsky.app`** — it returns real data — so the
   endpoint is not authentication-gated by design on the Bluesky AppView.
3. **It is throttled, not blocked.** The 403 is transient and endpoint-scoped: roughly **3 calls per
   IP, then refusal, then recovery within minutes**, reproducible across separate bursts, while other
   endpoints on the same host and IP are unaffected throughout.
4. **The cause and the exact window are not established from primary sources.** Nothing in the Bluesky
   docs describes any `searchPosts` limit, the responses carry **no `ratelimit-*` headers**, and the
   403 is an HTML/openresty refusal rather than the documented `429 Too Many Requests`. The observed
   ~3-call burst is a **dated measurement from one IP on one day**, not a published figure, and must
   not be quoted as a policy limit.

**Sustained-rate probe, same day.** A poll at one request per 15 seconds over 28 consecutive calls
settled into an alternating pattern of 200s and 403s — **12 served, 16 refused (43%), i.e. on the
order of 1.7 successful `searchPosts` calls per minute** from one unauthenticated IP. At that rate a
full sweep of ~26 tickers takes on the order of a quarter-hour and a few hundred queries/day is
achievable *if* the client backs off on 403 and retries. **This is a dated measurement from a single
IP over 28 samples, not a published figure — do not treat the ratio as a specification.**

**Implication for the design:** treat unauthenticated `searchPosts` as a convenience, not a
foundation. A ~3-call burst with a cooldown, and ~1.7 sustained calls/minute, is a thin and
undocumented budget for polling ~26 tickers, and it can change without notice. The documented normal
path — a free self-service Bluesky account, an app password or OAuth session, requests proxied via
the PDS — is the one to build against. That path still involves **no approval, no key issuance, and
no fee**, so the §1.1 verdict on the access *gate* is unchanged; only the transport changes.
**Whether the same throttle applies to an authenticated session is untested** (no credentials were
provisioned for this report) and is the single most decision-relevant open item — see §9.

**Note on the difference between routing and circumventing.** Moving from `public.api.bsky.app` to
`api.bsky.app` is a switch between two hosts Bluesky itself documents, and authenticating is the
documented path. Neither is circumvention. Defeating the 403 by other means would be, and the
[Community Guidelines](https://bsky.social/about/support/community-guidelines) §"Site Security" bar
is explicit: *"Do not attempt to compromise, exploit, bypass, abuse, or disrupt Bluesky's systems,
security features, APIs, rate limits, or infrastructure."*

---

## 2. Rate limits

The [Rate Limits](https://bsky.network/docs/rate-limits) page is the only primary source. It is
structured by service, and **the AppView is the one service for which it publishes no number.**

**Framing first:**

> "Many HTTP API services return rate limit headers on responses. Developers can use those to debug
> and understand the current limits, or even automate request throughput and backoff. Requests that
> cross a limit usually receive an HTTP 429 ('Too Many Requests') response status code. […] All of
> the limits described here are likely to evolve over time."

**(a) Content write operations — points-based, per account. Not applicable to reads.**

> "The limit is 5,000 points per hour and 35,000 points per day."

with `CREATE` = 3 points, `UPDATE` = 2, `DELETE` = 1, yielding "at most 1,666 records per hour and
11,666 records per day". These are *repository record writes*. **A read-only sentiment consumer
writes no records and is not touched by this.**

**(b) Hosted account (PDS) limits — request-based.** For requests that go through the account's PDS
(which is where authenticated `app.bsky.*` reads are routed, per §1.1):

> "Overall API Requests (all endpoints) — Rate limited by IP — **3000 per 5 minutes**"

plus per-endpoint limits on identity and session operations, of which one matters for a long-running
authenticated client:

> "`com.atproto.server.createSession` — Measured per account — **30 per 5 minutes**, **300 per day**"

**(c) The Bluesky AppView — no number published.** In full:

> "These API services have generous rate-limits. Please contact us if you encounter rate-limiting."

**So the honest answer to "exact published limits for unauthenticated public AppView reads" is:
there are none.** Writes are points-based; the PDS is request-based per IP; the AppView publishes
neither a scheme nor a number. **Not established from primary sources.** What would settle it: the
`ratelimit-limit` / `ratelimit-remaining` / `ratelimit-reset` response headers the doc says "many"
services return (**none were present on any AppView response observed on 2026-09-02**, 200 or 403),
or emailing Bluesky as the page invites.

**Against our load, none of the published figures binds.** A few hundred requests/day is a fraction of
a percent of the 3,000-per-5-minutes PDS allowance *per five-minute window*, and the authenticated
path needs one `createSession` per session refresh against a 300/day ceiling.

**But the published figures are not the operative constraint.** §1.2 measured an **undocumented
`searchPosts` throttle that refuses after ~3 unauthenticated calls from one IP** — orders of magnitude
below anything published, on the one endpoint the design depends on, returning a 403 rather than the
documented 429 and carrying no rate-limit headers. **Size the design off a measured authenticated
trial, never off the published numbers.**

**Jetstream** (the filtered firehose, §5) publishes no per-consumer rate limit either; it publishes
*filter* caps: "A single subscription accepts up to 100 collections and 10,000 DIDs."
([Jetstream](https://bsky.network/docs/jetstream))

---

## 3. Cost

**No published pricing, commercial tier, paid tier, or fee for API access was found in any primary
Bluesky source.** The [Rate Limits](https://bsky.network/docs/rate-limits) page's remedy for hitting
a limit is "Please contact us", not a paid upgrade. The
[API Hosts and Auth](https://bsky.network/docs/api-directory) page describes hosts and auth with no
mention of billing. The [Terms of Service](https://bsky.social/about/support/tos) contain no fee,
payment, or subscription term for API access — the only payment reference in the corpus read is the
[Privacy Policy](https://bsky.social/about/support/privacy-policy)'s generic "When you make a
purchase, a third party service provider that handles payments for us will receive the payment
information you provide", which concerns consumer purchases in the app, not developer access.

Jetstream is additionally free to self-host: "Jetstream is open source, implemented in Go, and cheap
to self-host." ([Jetstream](https://bsky.network/docs/jetstream))

**This is a categorical difference from Reddit**, where doc 24 §2.2 had to record "Reddit reserves the
right to charge fees […] rates to be determined at Reddit's sole discretion" with no published rate
card. **No Bluesky primary source reserves a right to charge for API access.** (Absence of a
reservation is not a guarantee of permanence — Bluesky can change its terms under ToS §14, "We may
update these Terms periodically.")

---

## 4. Licensing / terms of use

**Documents read in full for this section, so that "no such clause" is auditable:**

- [Terms of Service](https://bsky.social/about/support/tos) — **Last Updated: 14 August, 2025**
- [Community Guidelines](https://bsky.social/about/support/community-guidelines)
- [Privacy Policy](https://bsky.social/about/support/privacy-policy)
- [Developer Guidelines](https://bsky.network/docs/developer-guidelines)
- [Copyright Policy and Intellectual Property Policy](https://bsky.social/about/support/copyright) —
  **Last Updated: 29 January, 2026**; named by ToS §16 as part of the agreement. It is a DMCA-style
  notice-and-takedown and counter-notice procedure end to end (§1 defined terms, §2 submission types,
  §3 counter-notification, repeat-infringer policy). It contains **no use restriction of any kind** —
  the search terms below return no hit in it other than its §1 cross-reference to the ToS.
- [AT Protocol Network Services Privacy Notice](https://bsky.social/about/support/network-services-privacy-policy)
  — **Last Updated: May 22, 2024**; the notice governing `bsky.social` / the Bluesky Application API
  Server as network services. It imposes no developer use restriction, and its Overview states
  affirmatively: *"**User Content is Public.** If end users … create accounts with Developer
  Applications, content including their profiles and posts will be available to the general public."*
- The support index at `bsky.social/about/support`, to confirm no further legal page exists

**The support index lists exactly these legal pages:** `branding`, `community-guidelines`,
`copyright`, `find-friends-privacy-policy`, `network-services-privacy-policy`, `privacy-policy`,
`regulatory-compliance-report`, `tida-info`, `tida-notice`, `tos`, `tos-gov`, `trademarks`.
**There is no "Developer Terms", "API Terms", or "Data API Terms" page.** This is the structural
difference from Reddit, which has three separate developer-facing agreements (doc 24 §2.4).

### (a) Restriction on automated or programmatic access, or scraping — **none found**

The Terms of Service were searched for `scrap`, `automat`, `crawl`, `robot`, `bot`, `data mining`,
`reverse engineer`, and `API`. **The only match anywhere in the document is Bluesky describing its
own moderation tooling** (§4, "We proactively use automated tools and human moderation…").

**There is no prohibited-uses section in the Bluesky ToS.** There is no clause resembling StockTwits
§5's "You may not scrape, harvest, mirror, frame, deep-link to, data-mine, or otherwise extract data
or content from the Service by automated means" (doc 24 §1.2). **Not "we could not retrieve it" —
retrieved in full, and the clause does not exist.**

The nearest thing to an automation rule is the [Developer Guidelines](https://bsky.network/docs/developer-guidelines),
and it is a rule about *writes*, not reads. Guideline 1, in full:

> "**Don't spam.** We trust that you will create a great app that will grow organically. Our
> definition of spam includes:
> - Generating automated or bulk interactions, including any that would cause a notification to a
>   user like a message, follow, like or reply
> - Any method to automate generating followers or interactions, including account generation tools
> - Spambots"

**Every clause is scoped to generating interactions.** A read-only sentiment consumer generates none.
The [Community Guidelines](https://bsky.social/about/support/community-guidelines) similarly bar
"automated harassment systems" under Harassment, and nothing else automation-related.

Note the Developer Guidelines' own scope line — it matters for §5:

> "Developers who federate their apps or services on the AT Protocol must adhere to the Bluesky
> Developer Guidelines in order to communicate with Bluesky services"

Whether a private, read-only, non-federating consumer "federates their app or service" is arguable.
**Flagged, not resolved** — and the safest posture is to behave as though it binds, which costs
nothing here (§5).

### (b) Commercial-use restriction — **none found**

The Terms of Service contain **no commercial-use definition and no commercial-use restriction**. The
only "commercial" matches in the corpus are in the
[Community Guidelines](https://bsky.social/about/support/community-guidelines) and are about
*posting*, not consuming:

> "Do not engage in commercial practices targeting minors…"
> "Do not post undisclosed commercial content, sponsored material, or advertising without clearly
> identifying its commercial nature to other users."
> "[Restricted goods]: Do not use Bluesky to unlawfully sell, advertise, provide services for, or
> facilitate commercial transactions for: [weapons, stolen goods, …]"

None of these reach a reader. **A person trading their own capital is not implicated by any clause in
any document read.**

### (c) Anything analogous to Reddit Developer Terms §4.1's "indirectly deriving revenue" bar — **none found**

Doc 24 §2.4(b) quotes Reddit's bar on "sell, lease, sublicense, monetize, or otherwise obtain or
derive revenues of any kind from any portion of Reddit Services and Data, whether directly or
indirectly, including from any data derived from the foregoing" — the clause under which trading
profit is arguably captured.

**Bluesky has no equivalent. There is no revenue clause, direct or indirect, in the Bluesky Terms of
Service, Community Guidelines, Copyright Policy, or Developer Guidelines.** The ToS was searched for
`revenue`, `monetiz`, `profit`, `resell`, `resale`, `fee`, `charge` and `commerc`: **"revenue",
"monetize", "resell" and "commercial" do not appear at all**, and the only hits for "fee"/"profit"
are ordinary liability boilerplate — indemnification for "reasonable legal and accounting fees"
(§11), the exclusion of "lost profits" from damages (§12), and AAA arbitration filing fees (§14).
**None of them constrains what a reader may do with public posts.** **This is the single largest licensing difference between the two sources, and it removes
the tension doc 24 could not resolve for Reddit.**

### (d) Separate agreement required for automated access — **none**

ToS §16, "Entire Agreement":

> "These Terms, together with the Bluesky Community Guidelines, Privacy Policy, and Copyright Policy,
> constitute the complete and exclusive agreement between you and Bluesky regarding your use of
> Bluesky. They supersede and replace any prior or contemporaneous agreements…"

**Four documents. No developer agreement among them, and none exists to sign.** Contrast doc 24 §2.1,
where Reddit's own wiki conditions access on "our Responsible Builder Policy, Developer Terms and
Data API Terms" plus an approval request.

### (e) The honest counterweight — absence of a prohibition is not an affirmative licence

Doc 24 was written against the failure mode of over-reading a restrictive clause. **The mirror-image
failure is reading silence as a grant, and it should be stated rather than glossed.**

ToS §3 says "You retain ownership of your Content on the Bluesky application and website. Bluesky
does not claim rights to your Content, except for the limited rights you grant us under this
license." The licence users grant runs **to Bluesky**, for Bluesky to "develop, operate, and enhance
Bluesky, the AT Protocol, and future products and services" — **it is not a licence to third-party
readers**, and §15 adds "We reserve all rights not expressly granted to you in these Terms."

So the accurate statement is: **Bluesky's terms do not prohibit this use, and Bluesky's architecture
is designed for third-party consumption of public data, but no document affirmatively licences a
reader to redistribute post content.** For our profile that gap is immaterial — nothing is
redistributed, nothing is republished, no post text is retained (§5) — but it would matter for any
design that stored or displayed post bodies to anyone.

One further primary source bearing on reader etiquette, though not on our case: the official blog
post [Using the Content Visibility Declaration](https://bsky.network/blog/content-visibility-declaration)
(September 1, 2026) introduces an `app.bsky.actor.contentVisibilityDeclaration` record with a
`hideFromAlgorithmicRecommendations` boolean, and asks that "apps should respect the declaration by
limiting their posts in algorithmic feeds". It is explicitly scoped by "intent and reach":

> "If you're building an internet reader app just for yourself, the reach is very small and won't
> result in anyone's posts unexpectedly going viral."

**A private single-operator sentiment scorer that publishes nothing is the paradigm low-reach case the
post carves out.** Recorded for completeness, not as an obligation.

---

## 5. Retention and deletion

### 5.1 What the primary sources require

**[Developer Guidelines](https://bsky.network/docs/developer-guidelines), item 3, in full:**

> "All services must have a method for deleting content a user has requested to be deleted."

Mandatory in wording, but scoped (per §4(a)) to developers who "federate their apps or services on
the AT Protocol … in order to communicate with Bluesky services."

**[Terms of Service](https://bsky.social/about/support/tos) §3, "Content Deletion":**

> "If you delete your account, we will use reasonable efforts to remove your Content from Bluesky, in
> accordance with applicable laws and with our Privacy Policy. We also will notify other services and
> Developer Applications on the AT Protocol that you have deleted your account. Due to the
> decentralized nature of the AT Protocol, we cannot control or force other services and Developer
> Applications on the AT Protocol to treat your Content in a particular way and some posts may
> continue to exist on these services that are outside our control. That means that complete deletion
> across the network may not always be possible."

Read together: **Bluesky broadcasts deletions and asks services to honour them, while acknowledging it
cannot compel them.** The Developer Guidelines duty is stated as a requirement; the ToS passage is an
acknowledgement that enforcement across the network is not possible. **Whether this is "mandatory" or
"advisory" for a non-federating private reader is not settled by any primary text** — the strongest
statement available is the Developer Guidelines' "must", and the safe posture is to honour deletions
regardless.

### 5.2 The decisive negative — no Reddit-style purge rule exists

Doc 24 §2.4(d) had to record Reddit's:

> "You must remove any user content in your possession that has been deleted from Reddit. […] we
> strongly recommend routinely deleting any stored user data and content **within 48 hours**. […]
> Note that retention of content and data that has been deleted—even if disassociated, de-identified
> or anonymized—is a violation of our terms and policies."

plus Data API Terms §6's requirement, on termination, to delete "any data or models that were derived
from User Content and Materials." **That pair is what made the Reddit archive design unusable and
what would have retroactively voided backtest reproducibility.**

**No Bluesky primary source contains any counterpart.** There is no 48-hour recommendation, no rule
reaching de-identified or anonymised data, no termination-triggered destruction of derived data, and
no clause about derived models. **Not "we could not find one" — the Terms of Service, Community
Guidelines and Developer Guidelines were read in full, and the obligation is a single sentence
(§5.1) that reaches deleting *content*, not deleting derivations of it.**

### 5.3 Is a "score + permalink only, no post text" archive compatible?

**Yes, on the strongest reading available, and it is the design the sources point at.** The Developer
Guidelines duty is to delete *content*. A stored numeric sentiment score is not content; a permalink
is a public address, not content. Nothing in the Bluesky corpus extends the duty to derived data the
way Reddit's wiki explicitly does.

**Two honest caveats.**

1. **No primary text confirms that a stored permalink+score falls outside the duty.** It is inferred
   from the duty's scope. The same gap was flagged for Reddit in doc 24 §2.4(d) and it is flagged here
   too — the difference is that Bluesky has no clause pulling the other way, whereas Reddit had one.
2. **"Never author" is not strictly true of the permalink.** `bsky.app/profile/<handle>/post/<rkey>`
   **embeds the author's handle**, so a permalink archive is an archive of handles. This is a UK GDPR
   question for a UK-resident operator, not a Bluesky-terms question, and **no primary Bluesky source
   addresses a third-party reader's controller obligations.** The nearest relevant primary text is
   the [Privacy Policy](https://bsky.social/about/support/privacy-policy) §11: "Bluesky is a
   decentralized microblogging service where **most user activity is public by design**. This includes
   your posts, profile, likes, following, and blocks." **Flagged, not opined on** — the honouring-
   deletions mechanism in §5.4 is the mitigation that matters either way. A DID-keyed store
   (`at://did:plc:…/app.bsky.feed.post/<rkey>`, which the API returns as `uri`) rather than a
   handle-keyed permalink is worth considering, since DIDs are stable under handle changes.

### 5.4 The deletion event stream exists, is free, and needs no auth

[Jetstream](https://bsky.network/docs/jetstream) is the filtered firehose:

> "Jetstream is the easiest way to get data off the AT Protocol network at scale. Filter the records
> you want (likes, posts, a single account), and Jetstream streams them as plain JSON over one
> WebSocket, the moment they happen."

Deletions are first-class events:

> "A commit event — someone creating, updating, or deleting a record […] **A delete carries no
> `record` or `cid` — just the `collection` and `rkey` that identify what went away.**"

And it is open:

> "**No authentication is required for the live tail**; these instances serve the full network."

Public endpoints are `wss://jetstream.us-west.bsky.network` and `wss://jetstream.us-east.bsky.network`
(v2, recommended), with v1 instances still listed. Filters are server-side by `collections`, `dids`,
and `kinds`; resumption is by `cursor`, and "delivery is **at-least-once**, so an event may arrive
more than once across a reconnect. Make your handlers idempotent. Key on each record's `at://` URI."

**One split the caller must not miss.** The *live tail* is unauthenticated, but historical replay is
not:

> "This flow is called **Network Replay**. It uses the same filters as the live tail and **adds a few
> authenticated HTTP calls to pull the history**."

**Live = open, history = authenticated.** Doc 24 §4 made backtest replayability the deciding
constraint, so this matters: continuously tailing deletions from now on is free and anonymous;
backfilling a month of history is not.

### 5.5 Implementation trap: deleted permalinks return HTTP 200

**Empirical probe, 2026-09-02.** `https://bsky.app/profile/<handle>/post/<nonexistent-rkey>` returns
**HTTP 200** — the web app serves its SPA shell for any well-formed path. **Deletion detection cannot
key on HTTP status of the permalink.** The AppView answers correctly:
`app.bsky.feed.getPostThread` on a nonexistent `at://` URI returns **HTTP 400** with
`{"error":"NotFound","message":"Post not found: at://…"}`, while a live post returns 200. Use the
XRPC call (or the Jetstream delete event), not the web URL.

---

## 6. Finance-chatter volume — MEASURED, and it is the disqualifying finding

Sections 1-5 all came back favourable. This section is the binding question [#1041](https://github.com/dd-jp/samurai-trading-system/issues/1041) was filed to answer, and it is the one Bluesky fails.

### 6.1 Method

The public Jetstream firehose (`wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post`) was consumed **unauthenticated** and every `create` on `app.bsky.feed.post` matched against the 26 `screening_instrument` values in the checked-in pool (`server/providers/universe-pool/lse-etp-pool.ts`): AAPL AMD AMZN ARM BABA COIN EWY GOOG KWEB META MRNA MSFT MSTR NFLX NIO NVDA PLTR PYPL QQQ RACE SPY TSLA UBER VT XLE XYZ.

Jetstream was used rather than `searchPosts` deliberately. §8.2 establishes that **`$` is not a discriminating search token** — `q=NVDA` and `q=$NVDA` return identical rkeys and `hitsTotal` — so the API cannot answer "how many people wrote a cashtag". Reading the raw post text off the firehose can.

Two match forms were counted separately, because their precision differs enormously:

- **Cashtag** (`$NVDA`) — the unambiguous form. A post containing it is talking about the security.
- **Bare word** (`NVDA`) — an **upper bound only**. Many pool tickers are ordinary English or brand names: `ARM`, `RACE`, `COIN`, `META`, `VT`, `XYZ`, `NIO`, `UBER`, `SPY`, `GOOG`, `EWY`.

The sampler is checked in as [`25-bsky-firehose-sample.mjs`](25-bsky-firehose-sample.mjs) and needs no credentials: `node 25-bsky-firehose-sample.mjs <seconds>` under Node 22 (built-in `WebSocket`).

Bare-word hits were additionally tested against a finance-vocabulary regex (`STOCK|SHARES|TICKER|EARNINGS|NASDAQ|NYSE|BULLISH|BEARISH|PORTFOLIO|INVEST|TRADING|CALLS|PUTS|DIVIDEND|VALUATION|S&P|…`) to separate plausible markets posts from incidental use of the word.

### 6.2 Result

Window `2026-09-02T22:41:34Z` → `2026-09-02T22:51:34Z` (600 s), Node 22 built-in `WebSocket`:

| Measure | Value |
| --- | --- |
| Posts observed (whole network) | **25,269** |
| Post rate | 42.1 / s (≈ 3,638,712 / day) |
| **Cashtag hits, all 26 tickers combined** | **0** |
| Bare-word hits (upper bound, ambiguous) | 116 |
| Bare-word hits *also* finance-worded | **4** |

Bare-word distribution, `*` marking tickers that are ordinary words or brand names:

`RACE=32* ARM=18* META=15* AMZN=13 COIN=11* NIO=7* UBER=6* VT=5* AMD=2 NFLX=2 XYZ=2* BABA=1 MSTR=1 SPY=1*`

The head of that distribution is entirely ambiguous terms — `RACE`, `ARM`, `META`, `COIN` — i.e. the English words, not the securities. A confirming detail: an earlier 120-second sample over 4,840 posts also returned **0** cashtag hits.

By the rule of three, 0 observations in 25,269 puts the **95% upper bound at ≈432 cashtag posts per day network-wide across all 26 tickers combined** — under 17 per ticker per day *at the upper bound*, point estimate zero. The sentiment analyst reads a **24-hour window per instrument** (`sentiment-analyst.ts`, `MI_CONTEXT_WINDOW_MS`), so that is the directly relevant denominator.

### 6.3 The four finance-worded hits are worse than silence

Inspecting them individually is what turns a thin result into a disqualifying one. Verbatim excerpts, captured in the run:

- `"Life is Strange Reunion #Amazon Stock a Mínimo Histórico: 24.99€ ⚪️ https://amzn.to/4uSo1eb"` — **affiliate-link spam**. `AMZN` matched via the `amzn.to` shortener, not a discussion of the equity.
- `"NFLX Price Prediction: Smart Money Is Coiling — $83.32 Breakout or $78.28 Washout Within 48 Hours … #nflx #tokenized-sto[ck]"` — an automated **tokenized-stock pump bot**. The `$83.32` is a tokenized derivative's quote, not NFLX's share price.
- `"➤ NFLX tokenized stock is showing signs of accumulation divergence with high whale positioning and surging open interest…"` — same bot family.
- `"➤ The company's strategy involves a two-way approach to capital management, including selling Bitcoin to fund dividends and issuing MSTR sha[res]"` — the only arguably legitimate item, and itself an automated summary feed (same `➤` prefix).

So the ticker-adjacent content that does exist is dominated by **automated promotional accounts**, not human crowd sentiment. Wiring this into `MarketContext.social` would not produce a thin lens — it would produce an **adversarially poisoned** one. Pump bots are directionally biased by construction, and the sentiment analyst averages `item.sentiment` across the window (`directionFrom`/`confidenceFrom` in `sentiment-analyst.ts`), so coordinated promotion reads as bullish crowd conviction. That is strictly worse than the honest `NO_DATA_MARKER` absence the analyst emits today.

This also compounds with §8.2: because `$` does not discriminate, a production client could not cheaply filter to the precise form either. It would be scoring `RACE`, `ARM` and `META` collisions alongside the bots.

### 6.4 Limitation, and why the verdict survives it

**The sample ran after the US close** — 22:41-22:51 UTC, against a cash session ending 20:00 UTC — so it understates finance chatter. A market-hours replication is owed, and is cheap: run [`25-bsky-firehose-sample.mjs`](25-bsky-firehose-sample.mjs) for ten minutes between 13:30 and 20:00 UTC.

The verdict is nonetheless robust to that limitation, and the arithmetic says why. The observed cashtag count is **zero out of 25,269**. For Bluesky to reach even a modest 10 cashtag posts per ticker per day, market-hours density would have to exceed this window by **more than two orders of magnitude**. Intraday-versus-overnight social volume ratios are not remotely that large. The limitation is recorded honestly; it does not put the result in genuine doubt.

What would change the verdict, stated so a future revisit knows: a market-hours sample showing cashtag volume in the hundreds per ticker per day, *and* a way to separate human posts from the promotional accounts documented in §6.3.

### 6.5 Second-order finding: the ingestion shape is a real cost, though not the blocker

Volume is the disqualifier. This is recorded separately so a future revisit does not rediscover it.

§1.2 established that unauthenticated `searchPosts` is a **thin and undocumented budget** — edge-blocked entirely on `public.api.bsky.app`, and on `api.bsky.app` served at roughly 1.7 successful calls per minute with ~3-call bursts followed by cooldowns, carrying no `ratelimit-*` headers and refusing with a 403 rather than the documented 429. Samurai's Market Intelligence ingestion is **pull, per instrument, on demand**: `server/apps/orchestrator/production/analysts-adapter.ts:163` calls `refresh(trace_id, signal.asset, signal.asset_class)`. Sweeping 26 tickers against that throttle takes on the order of a quarter-hour per sweep, which does not fit a per-instrument refresh on the decision path. <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->

The documented remedy is an authenticated session — free, self-service, no approval — and **whether the same throttle applies to an authenticated session is untested** (§1.2, §9). The alternative is Jetstream, which is open and unthrottled but **push**: it would require a continuously-running collector filtering ~3.6M posts/day into the archive, a different component from every MI source built so far, paying its cost whether or not a relevant post ever arrives.

Either path is buildable. Neither is free, and adding the source is compile-gated: `MI_SOURCES` and `MI_SOURCE_HYDRATION` (#835) will not compile until the new source declares a boot-hydration policy. Given §6.2, this is moot — but it is the work that would have been required had volume been adequate.

---

## 7. Provenance — permalinks resolve with no login

**This is the deciding advantage over xAI `x_search`, and it was verified directly rather than
assumed.**

**Empirical probe, 2026-09-02, no cookies, no session, plain HTTP client:**
`GET https://bsky.app/profile/formdelta.bsky.social/post/3mukxnfsdf72p` returned **HTTP 200** with a
server-rendered document carrying `<title>@formdelta.bsky.social on Bluesky</title>` and an
`og:description` meta tag containing the post's own text. **No login wall, no interstitial, no
challenge.** The page is fetchable by a script and readable by a human in a browser.

Contrast doc 24's two alternatives:

- **xAI `x_search`** produces **login-walled citations** (doc 24, opening section and §4 item 3),
  which is the specific defect #969 was weighing.
- **Reddit** permalinks are logged-out-viewable in a browser, but doc 24 §2.6 recorded that
  `reddit.com` "returned JavaScript shells to non-browser clients", so script re-fetch is unreliable
  without OAuth.

**Bluesky beats both**: the permalink is publicly resolvable *and* the canonical record is
re-fetchable by a script through an unauthenticated XRPC call (`getPostThread`, §5.5), which is a
stronger provenance guarantee than a URL a human can open.

**Caveat, stated plainly:** the permalink is only *stably* resolvable while the handle is unchanged.
Handles are mutable on Bluesky (`com.atproto.identity.updateHandle` appears in the rate-limits table).
The DID-based `at://` URI returned in the API response (`at://did:plc:…/app.bsky.feed.post/<rkey>`) is
the stable identifier. **Store both**: the `at://` URI for machine re-fetch and stability, the
`bsky.app` permalink for human verification.

---

## 8. Data access shape

### 8.1 What `searchPosts` accepts

From [`app/bsky/feed/searchPosts.json`](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/searchPosts.json)
(`bluesky-social/atproto`), the authoritative parameter list:

| Param | Notes (quoted from the lexicon) |
|---|---|
| `q` (**required**) | "Search query string; syntax, phrase, boolean, and faceting is **unspecified, but Lucene query syntax is recommended**." |
| `sort` | `top` \| `latest`, default `latest` — "Specifies the ranking order of results." |
| `since` / `until` | "Filter results for posts after/before the indicated datetime […] Expected to use 'sortAt' timestamp, **which may not match 'createdAt'**. Can be a datetime, or just an ISO date (YYYY-MM-DD)." |
| `author` | "Filter to posts by the given account. Handles are resolved to DID before query-time." |
| `mentions` | "Filter to posts which mention the given account […] Only matches rich-text facet mentions." |
| `lang` | "Filter to posts in the given language." |
| `domain` | "Filter to posts with URLs (facet links or embeds) linking to the given domain (hostname)." |
| `url` | "Filter to posts with links (facet links or embeds) pointing to this URL." |
| `tag` | "Filter to posts with the given tag (hashtag), based on rich-text facet or tag field. **Do not include the hash (#) prefix.** Multiple tags can be specified, with 'AND' matching." |
| `limit` | integer, min 1, **max 100**, default 25 |
| `cursor` | "Optional pagination mechanism; **may not necessarily allow scrolling through entire result set**." |

Response: `posts` (required), plus optional `cursor` and `hitsTotal` — the latter documented as
"Count of search hits. **Optional, may be rounded/truncated, and may not be possible to paginate
through all hits.**" A live probe returned `hitsTotal: 10000`, which given that caveat should be read
as a ceiling marker, **not as a post count**. Declared error: `BadQueryString`.

### 8.2 Filtering by keyword or cashtag

- **Keyword: yes, `q` is a free-text query**, but **the query syntax is explicitly undocumented** —
  "unspecified, but Lucene query syntax is recommended". **No primary source specifies operator
  behaviour** (phrase, boolean, escaping). Any operator reliance must be probed empirically.
- **Hashtag: yes, first-class**, via the `tag` array parameter with AND semantics.
- **Cashtag (`$NVDA`): no documented support, and the `$` appears to be ignored.** There is no cashtag
  parameter and no primary source describing `$`-prefix handling.

  **Empirical A/B, 2026-09-02:** `q=NVDA&limit=5` and `q=$NVDA&limit=5` against `api.bsky.app`
  returned the **same five posts in the same order**, with the same `hitsTotal`. The top hit matched
  on a rich-text facet of type `app.bsky.richtext.facet#tag` with `tag: "NVDA"` — i.e. a **hashtag**
  match. **On this evidence `$` is not a discriminating token and cashtag search is not a distinct
  capability**; a `$`-prefixed query is a plain keyword query for the bare symbol.

  **Design consequence:** a bare-ticker keyword query will collide with ordinary English for symbols
  that are also words, and the ~26-instrument universe contains such names. **Disambiguation is the
  consumer's problem, not the API's** — candidate mitigations are the `tag` parameter (exact hashtag
  match, AND semantics), `lang=en`, and client-side facet inspection of `record.facets`. None of these
  is validated here. **`hitsTotal` was identical (10000) for both queries**, consistent with it being a
  capped ceiling rather than a count (§8.1), so it cannot be used to compare query selectivity.

### 8.3 What comes back per post

`posts[]` items are `app.bsky.feed.defs#postView`. From
[`app/bsky/feed/defs.json`](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/defs.json):

**Required:** `uri` (the stable `at://` URI), `cid`, `author`, `record`, `indexedAt`.
**Optional:** `embed`, `replyCount`, `repostCount`, `likeCount`, `quoteCount`, `bookmarkCount`,
`viewer`, `labels`, `threadgate`, `debug`.

`author` is an `app.bsky.actor.defs#profileViewBasic` — observed live as `did`, `handle`,
`displayName`, `avatar`, `associated`, `labels`, `createdAt`. `record` is the raw
`app.bsky.feed.post` record, observed live as carrying `text`, `createdAt`, `facets` (including
`#tag` features), `langs`, and any `embed`.

**Relevance to the stated design:** post `text` arrives in the response and is scored at inference
time; only `uri` (+ optionally the derived permalink) and the numeric score are persisted. The
engagement counters (`likeCount`, `repostCount`, `replyCount`, `quoteCount`) are available for
weighting and are themselves numeric, so retaining them does not reintroduce content storage —
**though no primary source addresses whether stale counters are subject to any deletion duty, and
they are not needed for the specified design.**

---

## 9. What this means for #969

> **RESOLVED 2026-09-03, and not by any of the branches below ([#969](https://github.com/dd-jp/samurai-trading-system/issues/969), [ADR-0020](../adr/0020-x-retrieval-through-nous.md)).** The question this section answers — *is an ADR-0009 exception needed?* — turned out to have no subject. ADR-0009 recorded that Nous "proxies `chat/completions` only", so `x_search` was unreachable; that was false. Nous serves `POST /responses`, and the tool runs there on the routed alias `~x-ai/grok-latest` with the credential this system already holds. **X retrieval ships INSIDE the single-provider rule — no exception, no second vendor, no new key** — and the direct xAI path, re-tested, is both dead (`401 bad-credentials`) and 20% more expensive per line. Everything below stands as licensing and volume research; only its framing as an exception decision is superseded. **Reddit ([#976](https://github.com/dd-jp/samurai-trading-system/issues/976)) remains wanted** — David's ruling is to soak with X now and merge Reddit when App Review reports, so the ladder did not stop, it gained a rung.

**Bluesky is the first of the three social sources examined whose terms do not block this use case.**

- StockTwits (doc 24 §1): **UNUSABLE** — the only lawful automated channel is closed to registration.
- Reddit (doc 24 §2): **gated** behind a discretionary approval that must disclose the trading use,
  under a revenue clause that plausibly captures trading profit, and under retention rules
  incompatible with any durable archive.
- **Bluesky: no gate, no fee, no revenue clause, no purge rule, no separate agreement, and public
  no-login provenance that beats both xAI `x_search` and Reddit.**

**The residual risks are operational, not legal, and both are testable cheaply:**

1. **`searchPosts` throughput (§1.2).** ~3 unauthenticated calls per IP, then an endpoint-scoped 403
   with a multi-minute cooldown, undocumented and header-less. **Before committing, run a multi-hour
   trial from an authenticated session** — free account, app password, requests proxied via the PDS —
   and record the sustained `searchPosts` rate achievable. Until that is done, "Bluesky has an open
   search API" should be stated as "Bluesky has an open search API whose sustainable query rate is
   unestablished." If the authenticated path lifts the throttle, ~26 tickers at a few hundred
   requests/day is comfortably inside the published PDS budget; if it does not, the design must fall
   back to a Jetstream live tail filtered to `app.bsky.feed.post` and keyword-match locally, which is
   unauthenticated, unthrottled per the docs, and independently attractive because it is the same
   stream that carries deletions (§5.4).
2. **Volume (§6). MEASURED, AND IT FAILED.** Doc 24 §3 named coverage as Bluesky's suspected
   weakness; §6 turned the suspicion into numbers. **0 cashtag mentions of any of the 26 tickers in
   25,269 posts**, and the four finance-worded bare-word hits were affiliate spam and tokenized-stock
   pump bots. This gate is closed, and no licensing finding above reopens it. Risk 1 is consequently
   moot — there is no point establishing a sustainable query rate against a source with nothing to
   query for.

**Recommended posture, had volume cleared** (retained because it is the design a future revisit would start from, not a live recommendation)**:** authenticated `searchPosts` polling for the ~26 screening
instruments, keyed on the US underlying per
[#960](https://github.com/dd-jp/samurai-trading-system/issues/960); persist `at://` URI + permalink +
numeric score only; subscribe to the Jetstream live tail filtered to `app.bsky.feed.post` and drop
scores whose `rkey` appears in a delete event. **Budget for ticker-vs-word disambiguation** (§8.2 —
`$` is not a discriminating token, so bare-symbol queries collide with ordinary English). **No
ADR-0009 exception would have been needed** — this is an open public API, not a paid LLM-retrieval
vendor.

### The answer #1041 owes #969

**Bluesky does not resolve #969.** Under the rule pre-committed on #969 (2026-09-02), a source is
usable only if it can actually serve the lens; Bluesky cannot. The ladder therefore falls through
Bluesky to the remaining rung: **Reddit ([#976](https://github.com/dd-jp/samurai-trading-system/issues/976))**,
still awaiting submission. The ADR-0009 exception becomes live **only if Reddit also fails** — that
condition is now one outcome away rather than two.

> **Superseded 2026-09-03: the exception never became live, because it was never needed** (ADR-0020).
> X retrieval runs through Nous on the existing credential, so the ladder's last rung was reachable
> without leaving the single-provider rule. This section's verdict on **Bluesky is unchanged and
> stands** — 0 cashtag hits in 25,269 posts, and the only finance-worded hits affiliate spam and
> tokenised-stock pump bots. That measurement is now the *bar X must clear*: soak day 1 records the
> human-vs-bot split of cited handles, which is why the X archive keeps the handle.

---

## Unverified items, stated as gaps rather than inferences

- **Cause of the `searchPosts` 403s** on both AppView hosts (edge rule, WAF, geo, undocumented quota,
  or deliberate exclusion of search from the cached host). Not established from primary sources; no
  `ratelimit-*` headers were returned to disambiguate, and the status is 403 rather than the
  documented 429. Settled by: an authenticated trial, and/or contacting Bluesky as the rate-limits
  page invites.
- **Whether the `searchPosts` throttle applies to authenticated sessions.** Untested — no credentials
  were provisioned for this report. **The most decision-relevant open item.**
- **The exact `searchPosts` budget and window.** Measured only as "~3 calls, then 403, then recovery
  within roughly a minute" from one IP on one day. A dated observation, not a published limit.
- **Any published numeric rate limit for `api.bsky.app` / `public.api.bsky.app`.** No primary source
  publishes one. Settled by: observed `ratelimit-*` headers (none seen 2026-09-02) or by asking
  Bluesky.
- **`q` operator syntax generally** (phrase, boolean, escaping) — the lexicon calls it "unspecified".
  Settled only by probing. *(The narrower `$NVDA` vs `NVDA` question **was** settled empirically —
  see §8.2 — but on a single five-result comparison, not a systematic test.)*
- **Whether bare-ticker queries can be disambiguated** from ordinary-word collisions using `tag`,
  `lang`, or facet inspection. Not tested.
- **Whether the Developer Guidelines' deletion duty binds a non-federating, read-only private
  consumer.** The scope line says "Developers who federate their apps or services". Not resolved;
  honouring deletions anyway costs nothing.
- **Whether a stored permalink + numeric score falls outside "content" for the deletion duty.**
  Inferred from scope, not stated. No Bluesky clause pulls the other way (unlike Reddit's).
- **UK GDPR position of a permalink archive** (the permalink embeds a handle). Outside Bluesky's
  primary sources entirely.
- **Whether `hitsTotal: 10000` is a real count or a ceiling.** The lexicon says it "may be
  rounded/truncated"; treat as a ceiling marker until §6's measurement says otherwise.
- **Finance-chatter volume per ticker** — §6, measured separately.

---

## Correction to doc 24

[Doc 24](24-social-sentiment-source-options.md) §3 states: "the public AppView
(`public.api.bsky.app`) exposes `app.bsky.feed.searchPosts` without authentication", listing the
observed 403 under UNVERIFIED. **Both halves need amending:**

- **The public AppView is open to unauthenticated reads** — `getProfile`, `searchActors` and
  `getAuthorFeed` all returned 200 on that host on 2026-09-02, so the 403 doc 24 saw was not the host
  refusing anonymous traffic.
- **But `searchPosts` specifically does not serve unauthenticated traffic from that host**, and on
  `api.bsky.app` it is served under a tight undocumented throttle (~3 calls, then a transient 403).
  The named endpoint is the one exception to the open-access claim, and its own lexicon warns of this:
  "this API endpoint **may require authentication (eg, not public)** for some service providers and
  implementations."

Doc 24's other Bluesky claims hold: Jetstream is an open unauthenticated firehose (§5.4), permalinks
are public with no login (§7), and there is no approval gate and no per-call fee (§1.1, §3).

---

## Sources

All retrieved 2026-09-02. `docs.bsky.app` now 301-redirects to `bsky.network`; both forms are given
where the redirect matters.

**Bluesky Protocol Services documentation (`bsky.network`)**

- API Hosts and Auth — https://bsky.network/docs/api-directory (from https://docs.bsky.app/docs/advanced-guides/api-directory)
- Rate Limits — https://bsky.network/docs/rate-limits (from https://docs.bsky.app/docs/advanced-guides/rate-limits)
- Developer Guidelines — https://bsky.network/docs/developer-guidelines
- Jetstream — https://bsky.network/docs/jetstream
- Using the Content Visibility Declaration (official blog, September 1, 2026) — https://bsky.network/blog/content-visibility-declaration

**Bluesky legal pages (`bsky.social`)**

- Terms of Service, Last Updated 14 August 2025 — https://bsky.social/about/support/tos
- Community Guidelines — https://bsky.social/about/support/community-guidelines
- Privacy Policy — https://bsky.social/about/support/privacy-policy
- Copyright Policy and Intellectual Property Policy, Last Updated 29 January 2026 — https://bsky.social/about/support/copyright
- AT Protocol Network Services Privacy Notice, Last Updated 22 May 2024 — https://bsky.social/about/support/network-services-privacy-policy
- Support index (used to enumerate all legal pages) — https://bsky.social/about/support

**Lexicons (`bluesky-social/atproto` GitHub org)**

- `app.bsky.feed.searchPosts` — https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/searchPosts.json
- `app.bsky.feed.defs` (`postView`) — https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/defs.json

**Live endpoints probed 2026-09-02 (dated observations, not documents)**

- `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts` — 403 (BunnyCDN edge, `cdn-requestcountrycode: GB`)
- `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts` — 200 with data, then 403 (`Server: openresty`, "Request forbidden by administrative rules."), then 200 again after a cooldown; an eight-call burst of distinct queries gave `200 200 200 403 403 403 403 403`, and a 15-second-interval poll over 28 consecutive calls returned 12x200 / 16x403
- `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile`, `…actor.searchActors`, `…feed.getAuthorFeed` — 200
- `https://api.bsky.app/xrpc/app.bsky.actor.getProfile`, `…actor.searchActors`, `…feed.getAuthorFeed` — 200
- `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread` — 200 for a live post; 400 `NotFound` for a nonexistent `at://` URI
- `https://bsky.app/profile/formdelta.bsky.social/post/3mukxnfsdf72p` — 200, no login, server-rendered `og:description` carrying post text
- `https://bsky.app/profile/formdelta.bsky.social/post/<nonexistent-rkey>` — 200 (SPA shell)
- `q=NVDA` vs `q=%24NVDA` on `api.bsky.app/xrpc/app.bsky.feed.searchPosts` (`limit=5`) — identical result sets and identical `hitsTotal`
