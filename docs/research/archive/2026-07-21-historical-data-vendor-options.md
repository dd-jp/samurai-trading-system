# Historical Data Vendor Options — Stage 2 Validation

Research for GitHub issue #155 (child of wayfinder map #154, "Stage 2 Validation Execution"). Feeds decision ticket #157 ("Decide: historical data source + storage for Stage 2").

MVP universe: **SPY, QQQ, AAPL, TSLA** (US equities/ETFs) + **BTC-USD, ETH-USD** (crypto). MVP broker: **Alpaca** (paper). Long-term crypto plan: Kraken/Coinbase via `ccxt`.

---

## Recommendation (up front)

**No single source covers this universe well enough on its own. Recommended combo:**

- ~~**Equities (SPY/QQQ/AAPL/TSLA): do NOT rely on Alpaca's free/Basic historical bars alone for Stage 2 validation.** Alpaca's own docs do not state a depth limit for the free tier's *historical* (as opposed to real-time) data, and the free "Basic" plan is IEX-only, which is a materially different (thinner) tape than SIP-consolidated data — a confound for backtest realism.~~ **CORRECTED 2026-08-06 ([#483](../../issues/483)):** the IEX-only restriction applies to Alpaca's *real-time* feed only. **Historical SIP data IS served on the free Basic tier** (`feed=sip&adjustment=raw`; only the most recent 15 minutes withheld) — probed at 10.5 years of true unadjusted daily bars. This paragraph's premise caused #157's wrong equities decision; see `free-equities-ohlcv-2026-08-06.md` and ADR-0001's Broker/Data appendix. The caveat that `feed=iex` is a thinner tape stands — pin `feed=sip`. Alpaca remains fine for *execution* (already the chosen MVP broker) and is now also the chosen historical equities source.
- **Crypto (BTC-USD, ETH-USD): do NOT use Kraken's own OHLC REST endpoint for backtesting history.** It is confirmed limited to the most recent 720 candles per pair/interval, with no way to page further back via `since` — a hard blocker for multi-year backtests regardless of whether you call it directly or through `ccxt` (ccxt is a thin pass-through here, not a workaround).
- **Best-verified option for both depth and cost transparency: Polygon.io (now rebranded "Massive").** Its pricing page explicitly states tiered historical depth — free tier 2 years, Starter ($29/mo) 5 years, Developer ($79/mo) 10 years, Advanced ($199/mo) 20+ years for stocks; crypto Starter ($49/mo) offers "10+ years." This is the only one of the three vendors whose pricing page gives concrete, citable historical-depth numbers per tier.
- ~~Practical shape for Stage 2: use **Polygon/Massive** (or equivalent) as the historical OHLCV source for both equities and crypto in the validation harness, and keep **Alpaca** purely as the live/paper execution adapter — consistent with ADR-0001's abstraction-layer mandate (`BrokerAdapter` for execution, separate data source for backtest history).~~ **SUPERSEDED 2026-08-06 (map [#482](../../issues/482)):** the Polygon *paid* recommendation (and #157's $78/mo decision built on it) is overturned. Adopted stack: Alpaca free SIP (equities primary), Polygon free (equities fallback), Coinbase Exchange candles (crypto primary), Bitstamp (crypto fallback). See ADR-0001's Broker/Data appendix; the Polygon tier/pricing facts below remain accurate as reference, they just no longer drive the decision.

---

## 1. Alpaca (Market Data API)

**Sources consulted:**
- https://docs.alpaca.markets/docs/about-market-data-api (Market Data API overview)
- https://docs.alpaca.markets/reference/stockbars (historical stock bars endpoint)
- https://docs.alpaca.markets/reference/cryptobars-1 (historical crypto bars endpoint)
- https://alpaca.markets/pricing (redirected to a 404 at fetch time — see gaps section)

**Historical depth:**
- Stocks: "historical data extends back to 2016 for both subscription levels" (Basic/free and Algo Trader Plus). Source: https://docs.alpaca.markets/docs/about-market-data-api. No explicit statement that free-tier historical *queries* are capped shorter than this — the 2016 start applies to both tiers per that page.
- Crypto: the crypto bars reference page does not state a historical start date or depth limit. Source: https://docs.alpaca.markets/reference/cryptobars-1 — flagged as not stated.

**Cost / pricing tiers** (Source: https://docs.alpaca.markets/docs/about-market-data-api):
- Basic (free): IEX feed only (single-exchange tape, not consolidated), 200 requests/minute.
- Algo Trader Plus ($99/month): full SIP (CTA/UTP consolidated tape across all US exchanges) + full OPRA options feed, 10,000 requests/minute.
- Broker API partner tiers (Standard/StandardPlus3000/5000/10000) are priced $500–$2,000/month for 1,000–10,000 RPM — not relevant to a single-account MVP, noted for completeness.

**Rate limits:** 200 req/min (Basic/free) vs 10,000 req/min (Algo Trader Plus, $99/mo). Source: same page above. The stock/crypto bars reference pages additionally document `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` response headers for per-minute throttling (example values shown: limit 100, remaining 90) — these appear to be illustrative example values in the API reference rather than the actual production limit, so treat the 200/10,000 RPM figures from the overview page as authoritative.

**Survivorship-free-ness:** Not stated in either docs page consulted. No mention of delisted/renamed ticker handling. Flagged as unverified.

**Point-in-time-ness:** Stocks bars endpoint documents an explicit `adjustment` query parameter with values **raw** (no adjustment), **split** (stock-split adjusted), **dividend** (cash-dividend adjusted), **spin-off**, and **all** (combination, comma-separable). Source: https://docs.alpaca.markets/reference/stockbars. This means Alpaca does support pulling an unadjusted/point-in-time series for equities on request. The crypto bars endpoint has **no adjustment parameter at all** (source: https://docs.alpaca.markets/reference/cryptobars-1) — not needed for BTC/ETH since there are no splits/dividends, so this is expected rather than a gap.

**Access format:** REST API. Official npm client library exists: `@alpacahq/alpaca-trade-api` (not independently re-verified via npm in this pass — noted from prior project research, treat as needing a fresh npm check before implementation).

---

## 2. ccxt / Kraken

**Sources consulted:**
- https://docs.kraken.com/api/docs/rest-api/get-ohlc-data (Kraken OHLC REST endpoint)
- https://support.kraken.com/hc/en-us/articles/206548367-What-are-the-API-rate-limits- (Kraken public API rate limits)
- https://docs.ccxt.com/ (ccxt docs landing page — technical `fetchOHLCV` reference pages were not retrievable, see gaps)

**Historical depth:** **Confirmed limited.** Kraken's own OHLC endpoint doc states it "Returns up to 720 of the most recent entries" and explicitly: "older data cannot be retrieved, regardless of the value of `since`." Source: https://docs.kraken.com/api/docs/rest-api/get-ohlc-data. At the daily (1440-minute) interval this caps usable history at roughly ~2 years; at finer intervals (e.g. 1-minute) it's only ~12 hours. This is a hard blocker for multi-year Stage 2 backtests via Kraken's REST OHLC endpoint, confirming the concern flagged in the task brief.

**Cost:** Kraken's public market-data endpoints (including OHLC) are free/unauthenticated — no API key or paid tier required. Not contradicted by any source consulted, but pricing tiers page was not separately fetched; noted as reasonably confident from the endpoint doc requiring no auth, not from an explicit pricing page.

**Rate limits:** Kraken support doc states public endpoints should be called "at a frequency of 1 per second (or less)" to stay within limits; exceeding this risks temporary throttling ("a few seconds or longer"). Limits apply per IP address, and for Trades/OHLC endpoints specifically also per currency pair. Source: https://support.kraken.com/hc/en-us/articles/206548367-What-are-the-API-rate-limits-. No exact numeric requests-per-minute figure is disclosed for public endpoints beyond this "~1/sec" guidance.

**Survivorship-free-ness:** N/A in the traditional equities sense (crypto pairs aren't "delisted" the same way), and not addressed in the docs consulted.

**Point-in-time-ness:** Not applicable / not discussed — crypto OHLC has no corporate-action adjustment concept. No mention of retroactive restatement in the OHLC doc.

**Access format:** REST API (Kraken native) and, per the task brief's premise, `ccxt`'s unified `fetchOHLCV` method as a TypeScript-friendly wrapper (official npm package `ccxt`, JS/TS support). **I was not able to independently verify ccxt's `since`/`limit`/pagination semantics from ccxt's own primary docs in this session** — every ccxt docs URL fetched (docs.ccxt.com README, manual anchors, GitHub raw README) returned only the marketing landing page or a 404/403, not the technical manual page describing `fetchOHLCV` parameters. This is a real gap, not a "no limits found" finding — see gaps section below. Regardless of what ccxt itself allows, it cannot bypass Kraken's server-side 720-candle cap, since ccxt is a pass-through client, not a data store.

**Bottom line for Kraken/ccxt:** unsuitable as the sole historical source for Stage 2 backtesting of BTC-USD/ETH-USD; would need a separate historical vendor (e.g. Polygon/Massive crypto plan, or a dedicated crypto data provider) for anything beyond ~recent data, with Kraken/ccxt reserved for live/paper execution feeds later per the long-term broker plan.

---

## 3. Polygon.io (rebranded "Massive")

**Sources consulted:**
- https://massive.com/pricing (Polygon.io's pricing page — polygon.io/pricing 301-redirects here as of this research)
- https://massive.com/crypto (crypto-specific pricing page)

Note: Polygon.io appears to have rebranded to "Massive" — `https://polygon.io/pricing` returned an HTTP 301 redirect to `https://massive.com/pricing`. Treat this as the current primary source; flagged explicitly in gaps in case this is a partial/in-progress rebrand and older polygon.io docs/endpoints still apply for API calls themselves (only the marketing/pricing site redirect was confirmed, not the API base URL).

**Historical depth** (Source: https://massive.com/pricing, https://massive.com/crypto):
- Stocks Basic (free): 2 years.
- Stocks Starter ($29/mo): 5 years.
- Stocks Developer ($79/mo): 10 years.
- Stocks Advanced ($199/mo): 20+ years.
- Crypto/Currencies Basic (free): 2 years.
- Crypto/Currencies Starter ($49/mo): "10+ Years Historical Data."

This directly covers the MVP universe: SPY/QQQ/AAPL/TSLA under the Stocks plans, BTC-USD/ETH-USD under the Currencies (crypto) plan — both explicitly named as covering "popular coins including BTC and ETH," though the page did not give a per-symbol depth breakdown (stated at the plan level, not itemized per ticker).

**Cost / pricing tiers:** As above. Note these are two *separate* subscriptions (Stocks and Crypto/Currencies are billed independently) — a full MVP setup covering both equities and crypto history would require paying for both an equities tier and a crypto tier, not one combined plan. Source: https://massive.com/pricing and https://massive.com/crypto list them as separate product lines.

**Rate limits:**
- Free tier: 5 API calls/minute (stated for both Stocks Basic and Currencies Basic).
- Paid tiers (Stocks Starter/Developer/Advanced): "Unlimited" rate limit per the pricing table.
- Currencies Starter ($49/mo): "Unlimited API calls."
Source: https://massive.com/pricing, https://massive.com/crypto.

**Survivorship-free-ness:** Not stated on the pricing pages consulted. The free tier lists "reference data, corporate actions" as included features, which suggests some corporate-action/ticker-history awareness, but there is no explicit claim about retaining delisted/renamed tickers in historical queries. Flagged as unverified — would need the API reference docs (not the pricing page) to confirm.

**Point-in-time-ness:** Not addressed on the pricing pages. "Corporate actions" is listed as a feature category (implying splits/dividends data exists), but whether historical aggregate bars are offered in both raw/unadjusted and adjusted forms (Alpaca-style `adjustment` param) was not stated anywhere in the pages fetched. Flagged as unverified — needs a check of Polygon/Massive's actual API reference (`/docs`), which was not fetched in this pass (only the pricing pages were).

**Access format:** Pricing page mentions "Restful and WebSocket APIs," plus flat-file access via an S3-compatible interface for bulk historical downloads. Source: https://massive.com/crypto. An official `@polygon.io` npm package is understood to exist for TS/JS from general product knowledge but was **not verified via npm or docs in this session** — flagged as a gap.

---

## Comparison Table

| Criterion | Alpaca | ccxt / Kraken | Polygon.io ("Massive") |
|---|---|---|---|
| Historical depth (stocks) | Back to 2016, both free & paid tiers (docs.alpaca.markets) | N/A | Free: 2yr; $29/mo: 5yr; $79/mo: 10yr; $199/mo: 20+yr |
| Historical depth (crypto) | Not stated in docs | **Hard cap: 720 most recent candles only** (docs.kraken.com) — no full history via REST | Free: 2yr; $49/mo: 10+yr |
| Cost (entry tier unlocking useful depth) | Free (Basic/IEX) for stocks; $99/mo (Algo Trader Plus) for full SIP tape | Free (Kraken public endpoints, no key needed) but depth-capped regardless of cost | $29–199/mo (stocks) + separately $0–49/mo (crypto) |
| Rate limits | 200 req/min (free) / 10,000 req/min ($99/mo) | ~1 req/sec guidance, per IP (+ per pair for OHLC/Trades); no exact numeric cap disclosed | 5 calls/min (free) / "unlimited" (paid) |
| Survivorship-free-ness | Not stated | Not applicable / not addressed | Not stated |
| Point-in-time-ness | Yes — explicit `adjustment` param (raw/split/dividend/spin-off/all) for stocks; crypto has no adjustment concept | Not applicable (no corporate actions for crypto) | Not stated on pricing pages (needs API-reference check) |
| Access format | REST API; npm client exists (unverified this session) | REST (Kraken native) + ccxt unified `fetchOHLCV` (npm `ccxt`, TS-friendly, but parameter semantics unverified this session) | REST + WebSocket + S3 flat-file bulk download; npm client presumed but unverified this session |

---

## Unverified claims / explicit gaps

Being explicit per the task brief — these were **not** confirmed against a primary source and should not be treated as fact until checked directly (e.g., by the decision ticket #157 or a follow-up spike):

1. **Alpaca free-tier historical stock data may or may not be shorter than the 2016 start date claimed for both tiers.** The overview page states 2016 for "both subscription levels" but this reads like a general capability statement, not a rate-limited allowance — worth confirming with a live API call before relying on it.
2. **Alpaca crypto historical depth** — no start date or depth limit found in the crypto bars reference doc at all. Genuinely unknown from docs; needs a live test query (e.g., request BTC/USD bars from 2017) to determine empirically.
3. **Alpaca pricing page** (https://alpaca.markets/pricing) returned a 404 via WebFetch — pricing tier figures above come from the Market Data API overview doc, not the dedicated pricing page, so there may be additional/updated tiers not captured here.
4. **ccxt's own `fetchOHLCV` parameter semantics (`since`, `limit`, pagination behavior, and whether it surfaces or silently truncates Kraken's 720-candle cap)** could not be verified from ccxt's primary docs in this session — every ccxt.docs.ccxt.com URL and the GitHub README fetch returned only the marketing landing page, a 404, or a 403. This is a meaningful gap: it affects how painful it would be to reconstruct deeper crypto history by other means through ccxt tooling. Needs a direct read of `docs.ccxt.com/#/exchanges/kraken` or the ccxt GitHub wiki/manual pages, or an actual `npm install ccxt` + source inspection.
5. **Kraken exact numeric rate limit** (calls/minute or a token-bucket count) was not disclosed — only the qualitative "~1 request/second" guidance from Kraken support was found. Kraken's REST rate-limits reference page (docs.kraken.com/api/docs/rest-api/rate-limits) returned an HTTP 500 error when fetched and could not be retrieved.
6. **Polygon.io / Massive rebrand scope** — confirmed only that the marketing/pricing domain redirects (polygon.io/pricing → massive.com/pricing). Whether the API base URL, npm package name, and existing docs.polygon.io reference docs remain unchanged, or have also moved/renamed, was not checked and should be verified before any integration work.
7. **Polygon/Massive survivorship-free-ness and point-in-time/adjustment behavior** — not addressed on the pricing pages fetched (https://massive.com/pricing, https://massive.com/crypto). These pages are commercial/marketing pages, not API reference docs; a follow-up fetch of the actual API reference (`/docs` or equivalent) is needed to answer these two criteria with a citable source.
8. **npm client library names/versions** for Alpaca (`@alpacahq/alpaca-trade-api`) and Polygon/Massive were stated from general knowledge, not verified via npmjs.com in this session (the one npm fetch attempted, for `ccxt`, returned an HTTP 403 and was not retried).

None of the above gaps were papered over with a guess in the body of this report — every number stated above under "Historical depth," "Cost," and "Rate limits" for all three vendors is directly cited to a URL that was successfully fetched in this session.
