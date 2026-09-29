# Marketaux as the UK-name news source (#1915)

David ruled on 2026-09-29 (chat, recorded on [#1915](https://github.com/dd-jp/samurai-trading-system/issues/1915)): run paper with the Marketaux free tier for UK single-stock news, and revisit EODHD after a 2-week soak. This doc holds the licence finding, the probe numbers that are the revisit baseline, and how the build behaves. Parent decision: [#1866](https://github.com/dd-jp/samurai-trading-system/issues/1866) item 5, map [#1706](https://github.com/dd-jp/samurai-trading-system/issues/1706).

## Licence for automated use: not answered

The question is whether a Marketaux free key may feed an automated trading system. The terms could not answer it. Read on 2026-09-29 from the raw pages with `curl`, not a summary.

Source: `https://www.marketaux.com/tos`, "Terms of Use", last updated January 10, 2021. The terms define "the Site" as the marketaux.com website and "any other media form, media channel, mobile website or mobile application related, linked, or otherwise connected thereto". They do not mention the API, an API key, or the data the API returns.

Clauses that bear on the question, verbatim:

- Intellectual Property Rights: "you are granted a limited license to access and use the Site and to download or print a copy of any portion of the Content to which you have properly gained access solely for your personal, non-commercial use."
- User Representations, item 6: "you will not access the Site through automated or non-human means, whether through a bot, script or otherwise".
- Prohibited Activities: "The Site may not be used in connection with any commercial endeavors except those that are specifically endorsed or approved by us."

What that means: read literally and if it reaches the API, a scripted client is barred and use is limited to personal non-commercial purposes. Whether it reaches the API is not stated. A paper account is arguably personal; the same key feeding a live account probably is not. This is a finding, not a licence.

Not addressed by the terms, the FAQ (`/faq`), the pricing page (`/pricing`) or the API documentation (`/documentation`), all read the same day: use in trading or algorithmic systems, caching or storing responses, use with LLMs, redistribution of article data, attribution, and whether the free plan is limited to non-commercial use. The FAQ says "We only provide a short snippet of articles along with their links." and "Each time the API is used to access financial news or analysis data, 1 API request is added to your daily usage." The documentation says "Store this and use it to find specific articles" about the article `uuid`, which is the only storage hint.

Consequences for the build:

- Paper runs use the free key. Whether a live run may is open; the build stores headline titles, publish times and counts only, and never article bodies or URLs.
- The written answer has to come from Marketaux (the site has a contact page). Nothing here should be quoted as permission.
- Before any live use of a Marketaux-fed decision, David asks Marketaux in writing whether the free and paid API keys may be used to inform automated trading decisions.

## API facts used by the build

Read from `/documentation` on 2026-09-29.

- `GET https://api.marketaux.com/v1/news/all`. Parameters used: `symbols=<TIDM>.L`, `published_after`, `published_before` (format `Y-m-dTH:i:s`), `language=en`, `limit=3`, `api_token`.
- All dates are in UTC. Default sort is `published_at`. `meta.found` is the number of matching articles; `meta.returned` is what the page carried.
- Free plan (pricing page): 100 requests a day, 3 articles per request. Basic is USD 29 a month for 2,500 daily requests.
- Errors: `402 usage_limit_reached` ("Usage limit of your plan has been reached"), `429 rate_limit_reached` ("Too many requests in the past 60 seconds"), `401 invalid_api_token`.
- The documentation does not say when the daily count resets or in which timezone.
- `group_similar` defaults to true, so near-duplicate articles are already merged.

Measured with two live requests on 2026-09-29 (`symbols=AZN.L`, 3-day window, limit 3), outside the tests:

- The response carries `X-RateLimit-Limit: 30` and `X-UsageLimit-Limit: 100`. The 30 is read as the per-minute limit the documentation's `429` describes; that reading is not documented. `X-UsageLimit-Remaining` was 64 at the first request, so 36 of the day's 100 were already spent by other probes, which is why the ceiling sits at 80 and not 100.
- One AZN article carried 6 entities: AZN, ZEG.DE, AZNCF, AZNN.MX, AZN.L and 0A4J.L, all named "AstraZeneca PLC". Cross-listings arrive as separate entities, so a raw entity count reads a single-company article as a roundup. The build counts distinct company names instead. A third article with 23 entities named 4 companies (AstraZeneca, Amgen, Eli Lilly, Novo Nordisk).
- Python's `urllib` was refused with a Cloudflare 403 (error code 1010); Node's `fetch`, which the build uses, was not. A change of HTTP client or user agent can therefore break the source without any code fault; it surfaces as `http_403` rows.

## Probe baseline for the 2-week revisit

Probe on 16 UK names as recorded on #1915 (30 days, `.L` symbols, `meta.found` per name):

| Name | Found | Name | Found |
|---|---|---|---|
| AZN | 39 | TSCO | 1 |
| HSBA | 24 | OCDO | 1 |
| BARC | 20 | Shell | 0 |
| GLEN | 10 | RR | 0 |
| BP | 8 | Auto Trader | 0 |
| VOD | 7 | Games Workshop | 0 |
| LLOY | 5 | Wise | 0 |
| RIO | 5 | | |
| RMV | 3 | | |
| THG | 3 | | |

Discrepancy, kept as recorded: the ticket says 16 names and "about 9 of 16 at 3+", but the list above has 17 names and 10 of them at 3 or more. The list is the primary record; the count in the sentence is not.

Symbol mapping quirks from the same probe: Shell mapped to RDSB.L, AZN to 0A4J.L, BP to BP-A.L, RIO to 0KWZ.L. The build asks for `<TIDM>.L` and keeps no alias map. Whether the entities Marketaux returns for those names are the right companies was not checked.

The probe window (30 days) is not the live window. The source asks for the trading date minus 3 calendar days at 00:00 UTC up to now (`MARKETAUX_LOOKBACK_CALENDAR_DAYS`), so the same name shows fewer articles live than in the probe. Compare the revisit against a like-for-like count, not against the table above. The US source uses 1 day; 3 is the builder's choice because 1 day would leave most UK names empty at these rates, and is a judgement for David (see the PR).

## What the build does

- Only names for which `isUkStock` is true go to Marketaux. UK ETFs stay NO_NEWS (doc 66 G18(2)); US names keep Alpaca News. Until the UK stock pool ([#1914](https://github.com/dd-jp/samurai-trading-system/issues/1914)) supplies that predicate, none qualifies.
- Every name is journalled in `v2_news` (append-only): status `ok`, `no_news`, `error`, `budget_stop` or `no_key`, the reason, whether a request was spent, `meta.found`, and the headlines with their publish times. A cycle's coverage line (`v2_uk_news_coverage`) counts UK names with headlines against NO_NEWS; it logs at warn when any name failed, hit the budget stop or had no key.
- Budget: a hard stop at 80 requests per UTC day (`MARKETAUX_REQUEST_CEILING`), counted from `v2_news` so it survives restarts; a `402` stops the source for the day; a `429` pauses it for 60 seconds. The per-day, per-symbol cache means a 20-name universe makes at most 20 requests a day.
- Point in time: the request carries `published_before=now`, and every article is filtered again on the client to `start <= published_at < now`. A cached day is served through the same filter, so replaying with an earlier `now` returns fewer headlines. Articles naming more than 5 distinct companies are dropped as wire roundups (doc 66 G18(3)).
- Window-coverage check: articles outside the window are dropped and counted (`out_of_window`), and `found` above the page size is recorded (`truncated`), so a provider that ignores the window or a page too small for the name is visible rather than silent.
- Nothing about the account, positions or capital is in a request; the only inputs are the ticker, two timestamps and the key. The key is read from `MARKETAUX_API_KEY` and appears in no journal row, log line or error text.

## Revisit query

After two weeks of paper cycles, coverage per day is:

```sql
SELECT trading_date,
       COUNT(DISTINCT symbol) AS names,
       COUNT(DISTINCT CASE WHEN status = 'ok' THEN symbol END) AS with_headlines,
       SUM(requested) AS requests
FROM v2_news
GROUP BY trading_date;
```

Decision inputs for the EODHD comparison: the share of names with headlines, the share of `error` and `budget_stop` rows, whether the odd-entity names (Shell, AZN, BP, RIO) returned sensible articles, and the answer to the licence question above.
